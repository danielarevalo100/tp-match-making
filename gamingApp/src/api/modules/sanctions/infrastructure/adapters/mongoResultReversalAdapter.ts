import type { Collection, Db, Document } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type {
  MatchLifecycleStatus,
  ScoringStatus,
} from "../../../matchClosure/business/models/matchClosure.js";
import type {
  RatingReversal,
  ReversibleMatch,
  SeasonCatalog,
  SeasonStanding,
} from "../../business/models/sanction.js";
import { MatchNotReversibleError } from "../../business/models/sanctionErrors.js";
import type { ResultReversalPort } from "../../business/ports/sanctionPorts.js";

type MatchDocument = {
  _id: string;
  closure?: { tsMs?: number };
  createdAt: Date;
  finalScoreboard?: { playerId: string; ratingDelta: number }[];
  mode: string;
  scoringStatus?: ScoringStatus;
  status: MatchLifecycleStatus;
  voided?: { at: Date; sanctionId: string };
};

type StandingDocument = {
  gamesPlayed: number;
  mmr: number;
  region: string;
  revision: number;
};

type PlayerDocument = {
  _id: string;
  seasonRatings?: Record<string, Record<string, StandingDocument>>;
};

type SeasonDocument = { _id: string; endsAt: Date; startsAt: Date; status: string };
type GameModeDocument = { _id: string; ranked: boolean };

function toReversibleMatch(document: MatchDocument): ReversibleMatch {
  return {
    createdAt: document.createdAt,
    endedAt: document.closure?.tsMs === undefined ? null : new Date(document.closure.tsMs),
    id: document._id,
    mode: document.mode,
    participants: (document.finalScoreboard ?? []).map((score) => ({
      playerId: score.playerId,
      ratingDelta: score.ratingDelta,
    })),
    scoringStatus: document.scoringStatus ?? "not_started",
    status: document.status,
    voidedBySanctionId: document.voided?.sanctionId ?? null,
  };
}

/**
 * Nuevo valor de `seasonRatings`, calculado dentro del update: en cada temporada afectada donde el
 * jugador tiene standing en el modo, se resta el delta de `mmr` y crece `revision` (así Redis lo
 * acepta); `gamesPlayed` solo baja en la temporada que contenía la partida. Las temporadas y modos
 * sin standing no se tocan, y un jugador sin `seasonRatings` sigue sin tenerlo.
 */
function seasonRatingsReversal(reversal: RatingReversal): Document {
  const standing = `$$season.v.${reversal.mode}`;
  const shifted = {
    $mergeObjects: [
      standing,
      {
        gamesPlayed: {
          $cond: [
            { $eq: ["$$season.k", { $literal: reversal.matchSeasonId }] },
            { $max: [{ $subtract: [`${standing}.gamesPlayed`, 1] }, 0] },
            `${standing}.gamesPlayed`,
          ],
        },
        mmr: { $subtract: [`${standing}.mmr`, reversal.delta] },
        revision: { $add: [`${standing}.revision`, 1] },
        updatedAt: reversal.at,
      },
    ],
  };
  return {
    $cond: [
      { $eq: [{ $type: "$seasonRatings" }, "object"] },
      {
        $arrayToObject: {
          $map: {
            input: { $objectToArray: "$seasonRatings" },
            as: "season",
            in: {
              k: "$$season.k",
              v: {
                $cond: [
                  {
                    $and: [
                      { $in: ["$$season.k", { $literal: [...reversal.seasonIds] }] },
                      { $eq: [{ $type: standing }, "object"] },
                    ],
                  },
                  { $mergeObjects: ["$$season.v", { [reversal.mode]: shifted }] },
                  "$$season.v",
                ],
              },
            },
          },
        },
      },
      "$$REMOVE",
    ],
  };
}

export class MongoResultReversalAdapter extends BaseMongoAdapter implements ResultReversalPort {
  private readonly gameModes: Collection<GameModeDocument>;
  private readonly matches: Collection<MatchDocument>;
  private readonly players: Collection<PlayerDocument>;
  private readonly seasons: Collection<SeasonDocument>;

  constructor(database: Db) {
    super(database);
    this.gameModes = database.collection<GameModeDocument>(mongoCollections.gameModes);
    this.matches = database.collection<MatchDocument>(mongoCollections.matches);
    this.players = database.collection<PlayerDocument>(mongoCollections.players);
    this.seasons = database.collection<SeasonDocument>(mongoCollections.seasons);
  }

  findMatches(matchIds: readonly string[]): Promise<ReversibleMatch[]> {
    return this.read(async () => {
      if (matchIds.length === 0) return [];
      const documents = await this.matches
        .find(
          { _id: { $in: [...matchIds] } },
          {
            projection: {
              "closure.tsMs": 1,
              createdAt: 1,
              "finalScoreboard.playerId": 1,
              "finalScoreboard.ratingDelta": 1,
              mode: 1,
              scoringStatus: 1,
              status: 1,
              voided: 1,
            },
          },
        )
        .toArray();
      return documents.map(toReversibleMatch);
    });
  }

  findSeasonCatalog(): Promise<SeasonCatalog> {
    return this.read(async () => {
      const [modes, seasons] = await Promise.all([
        this.gameModes.find({ ranked: true }, { projection: { _id: 1 } }).toArray(),
        this.seasons.find({ status: { $in: ["active", "closed"] } }).toArray(),
      ]);
      return {
        rankedModes: modes.map((mode) => mode._id),
        seasons: seasons.map((season) => ({
          endsAt: season.endsAt,
          id: season._id,
          startsAt: season.startsAt,
          status: season.status,
        })),
      };
    });
  }

  voidMatch(matchId: string, sanctionId: string, at: Date): Promise<void> {
    return this.write(async () => {
      const result = await this.matches.updateOne(
        { _id: matchId, scoringStatus: "applied", status: "closed" },
        { $set: { status: "voided", voided: { at, sanctionId } } },
      );
      if (result.matchedCount > 0) return;
      const current = await this.matches.findOne({ _id: matchId }, { projection: { status: 1 } });
      if (current?.status === "voided") return;
      throw new MatchNotReversibleError(matchId, current ? "not_scored" : "not_found");
    });
  }

  // Misma técnica que applyRating del problema 4: un update con pipeline por documento de jugador,
  // protegido por el id de la partida, así un reintento (o una segunda sanción que anula la misma
  // partida) nunca revierte dos veces.
  revertRating(reversal: RatingReversal): Promise<void> {
    return this.write(async () => {
      const rating = `ratings.${reversal.mode}`;
      const update: Document[] = [
        {
          $set: {
            [`${rating}.mmr`]: { $subtract: [`$${rating}.mmr`, reversal.delta] },
            [`${rating}.gamesPlayed`]: {
              $max: [{ $subtract: [{ $ifNull: [`$${rating}.gamesPlayed`, 0] }, 1] }, 0],
            },
            [`${rating}.updatedAt`]: reversal.at,
            revertedRatingMatches: {
              $concatArrays: [
                { $ifNull: ["$revertedRatingMatches", []] },
                [{ $literal: reversal.matchId }],
              ],
            },
            updatedAt: reversal.at,
          },
        },
      ];
      if (reversal.seasonIds.length > 0) {
        update.push({ $set: { seasonRatings: seasonRatingsReversal(reversal) } });
      }
      // Si no matchea: el problema 4 nunca le aplicó este rating al jugador, o ya se revirtió.
      await this.players.updateOne(
        {
          _id: reversal.playerId,
          appliedRatingMatches: reversal.matchId,
          revertedRatingMatches: { $ne: reversal.matchId },
        },
        update,
      );
    });
  }

  findStandings(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<SeasonStanding[]> {
    return this.read(async () => {
      if (playerIds.length === 0) return [];
      const players = await this.players
        .find(
          { _id: { $in: [...playerIds] } },
          { projection: { [`seasonRatings.${seasonId}.${mode}`]: 1 } },
        )
        .toArray();
      return players.flatMap((player) => {
        const standing = player.seasonRatings?.[seasonId]?.[mode];
        return standing
          ? [
              {
                gamesPlayed: standing.gamesPlayed,
                mmr: standing.mmr,
                playerId: player._id,
                region: standing.region,
                revision: standing.revision,
              },
            ]
          : [];
      });
    });
  }
}
