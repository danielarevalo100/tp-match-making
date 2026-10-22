import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type { MatchRecord } from "../../business/models/matchFormation.js";
import type { MatchRepositoryPort } from "../../business/ports/matchmakingPorts.js";

type MatchDocument = {
  _id: string;
  createdAt: Date;
  mode: string;
  players: MatchRecord["players"];
  ratingRange: number;
  region: string;
  status: "in_progress";
};

export class MongoMatchAdapter extends BaseMongoAdapter implements MatchRepositoryPort {
  private readonly matches: Collection<MatchDocument>;

  constructor(database: Db) {
    super(database);
    this.matches = database.collection<MatchDocument>(mongoCollections.matches);
  }

  // La clave es el matchId compartido, así un reintento nunca crea un segundo documento.
  create(match: MatchRecord): Promise<void> {
    return this.write(async () => {
      await this.matches.updateOne(
        { _id: match.id },
        {
          $setOnInsert: {
            createdAt: match.createdAt,
            mode: match.mode,
            players: match.players,
            ratingRange: match.ratingRange,
            region: match.region,
            status: "in_progress",
          },
        },
        { upsert: true },
      );
    });
  }

  delete(matchId: string): Promise<void> {
    return this.write(async () => {
      await this.matches.deleteOne({ _id: matchId, status: "in_progress" });
    });
  }
}
