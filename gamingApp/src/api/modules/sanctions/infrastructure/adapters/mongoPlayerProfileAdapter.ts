import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type {
  ProfileDirectoryEntry,
  ProfileSanctionRecord,
} from "../../business/models/playerProfile.js";
import type { ProfileDirectoryPort } from "../../business/ports/playerProfilePorts.js";
import type { SanctionDocument } from "../mappers/sanctionMapper.js";

type PlayerDocument = {
  _id: string;
  accountStatus: string;
  country: string;
  level: number;
  ratings?: Record<string, { gamesPlayed: number; mmr: number }>;
  region: string;
  registeredAt: Date;
  seasonRatings?: Record<
    string,
    Record<string, { gamesPlayed: number; mmr: number; region: string }>
  >;
  username: string;
};

type SeasonDocument = { _id: string; status: string };

export class MongoPlayerProfileAdapter extends BaseMongoAdapter implements ProfileDirectoryPort {
  private readonly players: Collection<PlayerDocument>;
  private readonly sanctions: Collection<SanctionDocument>;
  private readonly seasons: Collection<SeasonDocument>;

  constructor(database: Db) {
    super(database);
    this.players = database.collection<PlayerDocument>(mongoCollections.players);
    this.sanctions = database.collection<SanctionDocument>(mongoCollections.sanctions);
    this.seasons = database.collection<SeasonDocument>(mongoCollections.seasons);
  }

  findPlayer(playerId: string): Promise<ProfileDirectoryEntry | null> {
    return this.run("profile.findPlayer", async () => {
      const player = await this.players.findOne(
        { _id: playerId },
        {
          projection: {
            accountStatus: 1,
            country: 1,
            level: 1,
            ratings: 1,
            region: 1,
            registeredAt: 1,
            seasonRatings: 1,
            username: 1,
          },
        },
      );
      if (!player) return null;
      return {
        player: {
          accountStatus: player.accountStatus,
          country: player.country,
          id: player._id,
          level: player.level,
          region: player.region,
          registeredAt: player.registeredAt,
          username: player.username,
        },
        ratings: Object.entries(player.ratings ?? {}).map(([mode, rating]) => ({
          gamesPlayed: rating.gamesPlayed,
          mmr: rating.mmr,
          mode,
        })),
        standings: Object.entries(player.seasonRatings ?? {}).flatMap(([seasonId, modes]) =>
          Object.entries(modes).map(([mode, standing]) => ({
            gamesPlayed: standing.gamesPlayed,
            mmr: standing.mmr,
            mode,
            region: standing.region,
            seasonId,
          })),
        ),
      };
    });
  }

  findActiveSeasonId(): Promise<string | null> {
    return this.run("profile.findActiveSeason", async () => {
      const season = await this.seasons.findOne({ status: "active" }, { projection: { _id: 1 } });
      return season?._id ?? null;
    });
  }

  // Served by the { playerId, createdAt } index of `sanctions`.
  findSanctions(playerId: string, limit: number): Promise<ProfileSanctionRecord[]> {
    return this.run("profile.findSanctions", async () => {
      const documents = await this.sanctions
        .find({ playerId }, { projection: { adminId: 0, description: 0 } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
      return documents.map((document) => ({
        endsAt: document.endsAt,
        reason: document.reason,
        reversalStatus: document.reversal?.status ?? null,
        sanctionId: document._id,
        startsAt: document.startsAt,
        status: document.status,
        type: document.type,
        voidedMatches: document.reversal?.revertedMatchIds.length ?? 0,
      }));
    });
  }
}
