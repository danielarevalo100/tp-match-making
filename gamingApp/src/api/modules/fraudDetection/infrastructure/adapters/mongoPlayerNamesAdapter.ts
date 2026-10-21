import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type { PlayerNamesPort } from "../../business/ports/fraudPorts.js";

type PlayerNameDocument = { _id: string; username: string };

export class MongoPlayerNamesAdapter extends BaseMongoAdapter implements PlayerNamesPort {
  private readonly players: Collection<PlayerNameDocument>;

  constructor(database: Db) {
    super(database);
    this.players = database.collection<PlayerNameDocument>(mongoCollections.players);
  }

  findUsernames(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return this.run("fraud.findUsernames", async () => {
      if (playerIds.length === 0) return new Map<string, string>();
      const documents = await this.players
        .find({ _id: { $in: [...new Set(playerIds)] } }, { projection: { username: 1 } })
        .toArray();
      return new Map(documents.map((document) => [document._id, document.username]));
    });
  }
}
