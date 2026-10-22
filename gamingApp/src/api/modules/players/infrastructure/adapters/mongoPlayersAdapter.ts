import type { Collection, Db, Filter, UpdateFilter } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type {
  AccountStatus,
  Player,
  PlayerPage,
  PlayerProfileChanges,
} from "../../business/models/player.js";
import type { PlayersRepositoryPort } from "../../business/ports/playersPorts.js";
import {
  toConflictError,
  toPlayer,
  toPlayerDocument,
  type PlayerDocument,
} from "../mappers/playerMapper.js";

export class MongoPlayersAdapter extends BaseMongoAdapter implements PlayersRepositoryPort {
  private readonly collection: Collection<PlayerDocument>;

  constructor(database: Db) {
    super(database);
    this.collection = database.collection<PlayerDocument>(mongoCollections.players);
  }

  create(player: Player): Promise<void> {
    return this.write(async () => {
      try {
        await this.collection.insertOne(toPlayerDocument(player));
      } catch (error: unknown) {
        throw toConflictError(error) ?? error;
      }
    });
  }

  findByEmail(email: string): Promise<Player | null> {
    return this.read(async () => {
      const document = await this.collection.findOne({ email });
      return document ? toPlayer(document) : null;
    });
  }

  findById(id: string): Promise<Player | null> {
    return this.read(async () => {
      const document = await this.collection.findOne({ _id: id });
      return document ? toPlayer(document) : null;
    });
  }

  findByUsername(username: string): Promise<Player | null> {
    return this.read(async () => {
      const document = await this.collection.findOne({ username });
      return document ? toPlayer(document) : null;
    });
  }

  list(cursor: string | null, limit: number): Promise<PlayerPage> {
    return this.read(async () => {
      const filter: Filter<PlayerDocument> = cursor ? { _id: { $gt: cursor } } : {};
      const documents = await this.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit + 1)
        .toArray();

      const hasNextPage = documents.length > limit;
      const pageDocuments = hasNextPage ? documents.slice(0, limit) : documents;
      const lastDocument = pageDocuments.at(-1);

      return {
        items: pageDocuments.map(toPlayer),
        nextCursor: hasNextPage && lastDocument ? lastDocument._id : null,
      };
    });
  }

  updateProfile(
    id: string,
    changes: PlayerProfileChanges,
    updatedAt: Date,
  ): Promise<Player | null> {
    return this.write(async () => {
      const setFields: Partial<PlayerDocument> = { updatedAt };
      const unsetFields: Partial<Record<keyof PlayerDocument, "">> = {};

      if (changes.username !== undefined) setFields.username = changes.username;
      if (changes.email !== undefined) setFields.email = changes.email;
      if (changes.country !== undefined) setFields.country = changes.country;
      if (changes.region !== undefined) setFields.region = changes.region;

      if (changes.avatarUrl === null) unsetFields.avatarUrl = "";
      else if (changes.avatarUrl !== undefined) setFields.avatarUrl = changes.avatarUrl;

      if (changes.birthDate === null) unsetFields.birthDate = "";
      else if (changes.birthDate !== undefined) setFields.birthDate = changes.birthDate;

      const update: UpdateFilter<PlayerDocument> = { $set: setFields };
      if (Object.keys(unsetFields).length > 0) update.$unset = unsetFields;

      try {
        const document = await this.collection.findOneAndUpdate({ _id: id }, update, {
          returnDocument: "after",
        });
        return document ? toPlayer(document) : null;
      } catch (error: unknown) {
        throw toConflictError(error) ?? error;
      }
    });
  }

  updateStatus(id: string, status: AccountStatus, updatedAt: Date): Promise<Player | null> {
    return this.write(async () => {
      const document = await this.collection.findOneAndUpdate(
        { _id: id },
        { $set: { accountStatus: status, updatedAt } },
        { returnDocument: "after" },
      );
      return document ? toPlayer(document) : null;
    });
  }
}
