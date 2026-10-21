import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type {
  GameModeInfo,
  LeaderboardStanding,
  PlayerSummary,
  SeasonInfo,
} from "../../business/models/leaderboard.js";
import type { LeaderboardDirectoryPort } from "../../business/ports/leaderboardPorts.js";

type SeasonDocument = { _id: string; status: string };
type GameModeDocument = { _id: string; ranked: boolean };
type RegionDocument = { _id: string };

type StandingDocument = {
  gamesPlayed: number;
  mmr: number;
  region: string;
  revision: number;
};

type PlayerDocument = {
  _id: string;
  country: string;
  seasonRatings?: Record<string, Record<string, StandingDocument>>;
  username: string;
};

function standingPath(seasonId: string, mode: string): string {
  return `seasonRatings.${seasonId}.${mode}`;
}

function toStanding(
  player: PlayerDocument,
  seasonId: string,
  mode: string,
): LeaderboardStanding | null {
  const standing = player.seasonRatings?.[seasonId]?.[mode];
  // A standing with no games left (problem 8 voided every match of the season) is not ranked.
  if (!standing || standing.gamesPlayed < 1) return null;
  return {
    mmr: standing.mmr,
    playerId: player._id,
    region: standing.region,
    revision: standing.revision,
  };
}

export class MongoLeaderboardAdapter extends BaseMongoAdapter implements LeaderboardDirectoryPort {
  private readonly gameModes: Collection<GameModeDocument>;
  private readonly players: Collection<PlayerDocument>;
  private readonly regions: Collection<RegionDocument>;
  private readonly seasons: Collection<SeasonDocument>;

  constructor(database: Db) {
    super(database);
    this.gameModes = database.collection<GameModeDocument>(mongoCollections.gameModes);
    this.players = database.collection<PlayerDocument>(mongoCollections.players);
    this.regions = database.collection<RegionDocument>(mongoCollections.regions);
    this.seasons = database.collection<SeasonDocument>(mongoCollections.seasons);
  }

  findSeason(seasonId: string): Promise<SeasonInfo | null> {
    return this.run("leaderboard.findSeason", async () => {
      const season = await this.seasons.findOne({ _id: seasonId }, { projection: { status: 1 } });
      return season ? { id: season._id, status: season.status } : null;
    });
  }

  findMode(mode: string): Promise<GameModeInfo | null> {
    return this.run("leaderboard.findMode", async () => {
      const gameMode = await this.gameModes.findOne({ _id: mode }, { projection: { ranked: 1 } });
      return gameMode ? { id: gameMode._id, ranked: gameMode.ranked } : null;
    });
  }

  regionExists(region: string): Promise<boolean> {
    return this.run("leaderboard.findRegion", async () => {
      return (await this.regions.countDocuments({ _id: region }, { limit: 1 })) > 0;
    });
  }

  findPlayers(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<ReadonlyMap<string, PlayerSummary>> {
    return this.run("leaderboard.findPlayers", async () => {
      if (playerIds.length === 0) return new Map();
      const players = await this.players
        .find(
          { _id: { $in: [...playerIds] } },
          { projection: { country: 1, [standingPath(seasonId, mode)]: 1, username: 1 } },
        )
        .toArray();
      return new Map(
        players.map((player) => {
          const standing = player.seasonRatings?.[seasonId]?.[mode];
          return [
            player._id,
            {
              country: player.country,
              gamesPlayed: standing?.gamesPlayed ?? null,
              region: standing?.region ?? null,
              username: player.username,
            },
          ];
        }),
      );
    });
  }

  findStandings(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<LeaderboardStanding[]> {
    return this.run("leaderboard.findStandings", async () => {
      if (playerIds.length === 0) return [];
      const players = await this.players
        .find(
          { _id: { $in: [...playerIds] } },
          { projection: { [standingPath(seasonId, mode)]: 1 } },
        )
        .toArray();
      return players.flatMap((player) => toStanding(player, seasonId, mode) ?? []);
    });
  }

  async *listStandings(
    seasonId: string,
    mode: string,
    batchSize: number,
  ): AsyncIterable<LeaderboardStanding[]> {
    const path = standingPath(seasonId, mode);
    const cursor = this.players.find(
      { [`${path}.gamesPlayed`]: { $gte: 1 } },
      { batchSize, projection: { [path]: 1 } },
    );
    try {
      for (;;) {
        const batch = await this.run("leaderboard.listStandings", async () => {
          const standings: LeaderboardStanding[] = [];
          while (standings.length < batchSize) {
            const player = await cursor.next();
            if (!player) break;
            const standing = toStanding(player, seasonId, mode);
            if (standing) standings.push(standing);
          }
          return standings;
        });
        if (batch.length === 0) return;
        yield batch;
      }
    } finally {
      await cursor.close();
    }
  }
}
