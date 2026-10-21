import type { Collection, Db, Document } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type {
  ApplyRatingInput,
  DeclaredPlayerResult,
  FinishMatchInput,
  LeaderboardStanding,
  LeaderboardStatus,
  MatchClosureRecord,
  MatchLifecycleStatus,
  MatchParticipant,
  PlayerFinalScore,
  ScoringStatus,
} from "../../business/models/matchClosure.js";
import { MatchClosureConflictError } from "../../business/models/matchClosureErrors.js";
import type { MatchClosureRepositoryPort } from "../../business/ports/matchClosurePorts.js";

type ClosureDocument = {
  completedAt?: Date;
  eventId: string;
  id: string;
  reason: string;
  requestedAt: Date;
  results: DeclaredPlayerResult[];
  tsMs: number;
};

type MatchClosureDocument = {
  _id: string;
  closure?: ClosureDocument;
  createdAt: Date;
  finalScoreboard?: PlayerFinalScore[];
  leaderboard?: { status: Exclude<LeaderboardStatus, "pending">; updatedAt: Date };
  mode: string;
  players: MatchParticipant[];
  scoringAttempts?: number;
  scoringLastError?: string;
  scoringStatus?: ScoringStatus;
  scoringUpdatedAt?: Date;
  status: MatchLifecycleStatus;
};

type RatingDocument = {
  gamesPlayed: number;
  mmr: number;
  updatedAt: Date;
};

type SeasonStandingDocument = {
  gamesPlayed: number;
  mmr: number;
  region: string;
  revision: number;
  updatedAt: Date;
};

type RatingPlayerDocument = {
  _id: string;
  appliedRatingMatches?: string[];
  ratings: Record<string, RatingDocument>;
  region: string;
  seasonRatings?: Record<string, Record<string, SeasonStandingDocument>>;
  updatedAt: Date;
};

type SeasonDocument = { _id: string; endsAt: Date; startsAt: Date; status: string };
type GameModeDocument = { _id: string; ranked: boolean };

function toRecord(document: MatchClosureDocument): MatchClosureRecord {
  return {
    closureId: document.closure?.id ?? null,
    createdAt: document.createdAt,
    eventId: document.closure?.eventId ?? null,
    id: document._id,
    leaderboardStatus: document.leaderboard?.status ?? "pending",
    mode: document.mode,
    players: document.players.map((player) => ({ ...player })),
    results: document.closure?.results.map((result) => ({ ...result })) ?? null,
    scoringStatus: document.scoringStatus ?? "not_started",
    status: document.status,
  };
}

export class MongoMatchClosureAdapter
  extends BaseMongoAdapter
  implements MatchClosureRepositoryPort
{
  private readonly gameModes: Collection<GameModeDocument>;
  private readonly matches: Collection<MatchClosureDocument>;
  private readonly players: Collection<RatingPlayerDocument>;
  private readonly seasons: Collection<SeasonDocument>;

  constructor(database: Db) {
    super(database);
    this.gameModes = database.collection<GameModeDocument>(mongoCollections.gameModes);
    this.matches = database.collection<MatchClosureDocument>(mongoCollections.matches);
    this.players = database.collection<RatingPlayerDocument>(mongoCollections.players);
    this.seasons = database.collection<SeasonDocument>(mongoCollections.seasons);
  }

  find(matchId: string): Promise<MatchClosureRecord | null> {
    return this.run("matchClosure.findMatch", async () => {
      const match = await this.matches.findOne({ _id: matchId });
      return match ? toRecord(match) : null;
    });
  }

  prepare(input: FinishMatchInput): Promise<MatchClosureRecord | null> {
    return this.run("matchClosure.prepareMongo", async () => {
      const match = await this.matches.findOneAndUpdate(
        { _id: input.matchId, status: "in_progress" },
        {
          $set: {
            closure: {
              eventId: input.eventId,
              id: input.closureId,
              reason: input.reason,
              requestedAt: new Date(),
              results: input.results.map((result) => ({ ...result })),
              tsMs: input.tsMs,
            },
            scoringStatus: "not_started",
            status: "closing",
          },
        },
        { returnDocument: "after" },
      );
      return match ? toRecord(match) : null;
    });
  }

  rollbackPreparation(matchId: string, closureId: string): Promise<void> {
    return this.run("matchClosure.rollbackMongo", async () => {
      await this.matches.updateOne(
        { _id: matchId, "closure.id": closureId, status: "closing" },
        {
          $set: { status: "in_progress" },
          $unset: { closure: "", scoringStatus: "" },
        },
      );
    });
  }

  markClosedPending(matchId: string, closureId: string, closedAt: Date): Promise<void> {
    return this.run("matchClosure.markClosed", async () => {
      const result = await this.matches.updateOne(
        { _id: matchId, "closure.id": closureId, status: "closing" },
        {
          $set: {
            "closure.completedAt": closedAt,
            scoringStatus: "pending",
            scoringUpdatedAt: closedAt,
            status: "closed",
          },
        },
      );
      if (result.matchedCount > 0) return;
      const current = await this.matches.findOne({ _id: matchId });
      if (current?.status !== "closed" || current.closure?.id !== closureId) {
        throw new MatchClosureConflictError(matchId, current?.status ?? "missing");
      }
    });
  }

  beginScoring(matchId: string, closureId: string, at: Date): Promise<ScoringStatus> {
    return this.run("matchClosure.beginScoring", async () => {
      const match = await this.matches.findOneAndUpdate(
        {
          _id: matchId,
          "closure.id": closureId,
          scoringStatus: { $in: ["pending", "failed", "calculating"] },
          status: "closed",
        },
        {
          $inc: { scoringAttempts: 1 },
          $set: { scoringStatus: "calculating", scoringUpdatedAt: at },
          $unset: { scoringLastError: "" },
        },
        { returnDocument: "after" },
      );
      if (match) return match.scoringStatus ?? "calculating";
      const current = await this.matches.findOne({ _id: matchId });
      if (current?.scoringStatus === "applied" && current.closure?.id === closureId) {
        return "applied";
      }
      throw new MatchClosureConflictError(matchId, current?.status ?? "missing");
    });
  }

  completeScoring(
    matchId: string,
    closureId: string,
    scores: readonly PlayerFinalScore[],
    at: Date,
  ): Promise<void> {
    return this.run("matchClosure.completeScoring", async () => {
      const result = await this.matches.updateOne(
        { _id: matchId, "closure.id": closureId, status: "closed" },
        {
          $set: {
            finalScoreboard: scores.map((score) => ({ ...score })),
            scoringStatus: "applied",
            scoringUpdatedAt: at,
          },
          $unset: { scoringLastError: "" },
        },
      );
      if (result.matchedCount === 0) {
        throw new MatchClosureConflictError(matchId, "scoring_not_closable");
      }
    });
  }

  failScoring(matchId: string, closureId: string, message: string, at: Date): Promise<void> {
    return this.run("matchClosure.failScoring", async () => {
      await this.matches.updateOne(
        {
          _id: matchId,
          "closure.id": closureId,
          scoringStatus: "calculating",
          status: "closed",
        },
        {
          $set: {
            scoringLastError: message.slice(0, 1_000),
            scoringStatus: "failed",
            scoringUpdatedAt: at,
          },
        },
      );
    });
  }

  findLeaderboardSeason(mode: string, playedAt: Date): Promise<string | null> {
    return this.run("matchClosure.findLeaderboardSeason", async () => {
      const [gameMode, season] = await Promise.all([
        this.gameModes.findOne({ _id: mode }, { projection: { ranked: 1 } }),
        this.seasons.findOne(
          { endsAt: { $gte: playedAt }, startsAt: { $lte: playedAt }, status: "active" },
          { projection: { _id: 1 } },
        ),
      ]);
      return gameMode?.ranked === true && season ? season._id : null;
    });
  }

  applyRating(input: ApplyRatingInput): Promise<void> {
    return this.run("matchClosure.applyRating", async () => {
      const rating = `ratings.${input.mode}`;
      const update: Document[] = [
        {
          $set: {
            [`${rating}.mmr`]: {
              $add: [{ $ifNull: [`$${rating}.mmr`, input.fallbackMmr] }, input.delta],
            },
            [`${rating}.gamesPlayed`]: { $add: [{ $ifNull: [`$${rating}.gamesPlayed`, 0] }, 1] },
            [`${rating}.updatedAt`]: input.at,
            appliedRatingMatches: {
              $concatArrays: [
                { $ifNull: ["$appliedRatingMatches", []] },
                [{ $literal: input.matchId }],
              ],
            },
            updatedAt: input.at,
          },
        },
      ];
      if (input.seasonId) {
        // Second stage: it reads the mode rating the first stage just wrote, so the standing
        // copies the absolute value in the same atomic document update.
        const standing = `seasonRatings.${input.seasonId}.${input.mode}`;
        update.push({
          $set: {
            [`${standing}.mmr`]: `$${rating}.mmr`,
            [`${standing}.gamesPlayed`]: {
              $add: [{ $ifNull: [`$${standing}.gamesPlayed`, 0] }, 1],
            },
            [`${standing}.region`]: "$region",
            [`${standing}.revision`]: { $add: [{ $ifNull: [`$${standing}.revision`, 0] }, 1] },
            [`${standing}.updatedAt`]: input.at,
          },
        });
      }
      const result = await this.players.updateOne(
        { _id: input.playerId, appliedRatingMatches: { $ne: input.matchId } },
        update,
      );
      if (result.matchedCount > 0) return;
      const alreadyApplied = await this.players.findOne({
        _id: input.playerId,
        appliedRatingMatches: input.matchId,
      });
      if (!alreadyApplied) {
        throw new Error(`Player ${input.playerId} was not found while scoring.`);
      }
    });
  }

  findStandings(
    playerIds: readonly string[],
    mode: string,
    seasonId: string,
  ): Promise<LeaderboardStanding[]> {
    return this.run("matchClosure.findStandings", async () => {
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

  markLeaderboard(
    matchId: string,
    closureId: string,
    status: "published" | "not_ranked",
    at: Date,
  ): Promise<void> {
    return this.run("matchClosure.markLeaderboard", async () => {
      await this.matches.updateOne(
        { _id: matchId, "closure.id": closureId, scoringStatus: "applied" },
        { $set: { leaderboard: { status, updatedAt: at } } },
      );
    });
  }
}
