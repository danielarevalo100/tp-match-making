import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type { ActiveSeason, HistoryPlayer } from "../../business/models/playerHistory.js";
import type { PlayerDirectoryPort } from "../../business/ports/playerHistoryPorts.js";

type PlayerDocument = {
  _id: string;
  ratings?: Record<string, { mmr: number }>;
  username: string;
};

type SeasonDocument = {
  _id: string;
  endsAt: Date;
  startsAt: Date;
  status: string;
};

export class MongoPlayerDirectoryAdapter extends BaseMongoAdapter implements PlayerDirectoryPort {
  private readonly players: Collection<PlayerDocument>;
  private readonly seasons: Collection<SeasonDocument>;

  constructor(database: Db) {
    super(database);
    this.players = database.collection<PlayerDocument>(mongoCollections.players);
    this.seasons = database.collection<SeasonDocument>(mongoCollections.seasons);
  }

  findPlayer(playerId: string): Promise<HistoryPlayer | null> {
    return this.read(async () => {
      const player = await this.players.findOne(
        { _id: playerId },
        { projection: { ratings: 1, username: 1 } },
      );
      if (!player) return null;
      const ratings = Object.fromEntries(
        Object.entries(player.ratings ?? {}).map(([mode, rating]) => [mode, { mmr: rating.mmr }]),
      );
      return { id: player._id, ratings, username: player.username };
    });
  }

  findActiveSeason(): Promise<ActiveSeason | null> {
    return this.read(async () => {
      const season = await this.seasons.findOne({ status: "active" });
      return season ? { endsAt: season.endsAt, id: season._id, startsAt: season.startsAt } : null;
    });
  }
}
