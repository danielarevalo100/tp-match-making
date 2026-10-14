import {
  MongoServerError,
  type Collection,
  type Filter,
  type UpdateFilter,
} from "mongodb";

import { PlayerConflictError } from "../../domain/errors/player-errors.js";
import type { AccountStatus, Player } from "../../domain/entities/player.js";
import type {
  PlayerPage,
  PlayerProfileChanges,
  PlayerRepository,
} from "../../domain/repositories/player-repository.js";
import {
  toPlayer,
  toPlayerDocument,
  type PlayerDocument,
} from "./player-document.js";

export class MongoPlayerRepository implements PlayerRepository {
  constructor(private readonly collection: Collection<PlayerDocument>) {}

  async create(player: Player): Promise<void> {
    try {
      await this.collection.insertOne(toPlayerDocument(player));
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11_000) {
        const field = error.message.includes("email_1") ? "email" : "username";
        throw new PlayerConflictError(field);
      }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<Player | null> {
    const document = await this.collection.findOne({ email });
    return document ? toPlayer(document) : null;
  }

  async findById(id: string): Promise<Player | null> {
    const document = await this.collection.findOne({ _id: id });
    return document ? toPlayer(document) : null;
  }

  async findByUsername(username: string): Promise<Player | null> {
    const document = await this.collection.findOne({ username });
    return document ? toPlayer(document) : null;
  }

  async list(cursor: string | null, limit: number): Promise<PlayerPage> {
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
  }

  async updateProfile(
    id: string,
    changes: PlayerProfileChanges,
    updatedAt: Date,
  ): Promise<Player | null> {
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
      const document = await this.collection.findOneAndUpdate(
        { _id: id },
        update,
        { returnDocument: "after" },
      );
      return document ? toPlayer(document) : null;
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11_000) {
        const field = error.message.includes("email_1") ? "email" : "username";
        throw new PlayerConflictError(field);
      }
      throw error;
    }
  }

  async updateStatus(
    id: string,
    status: AccountStatus,
    updatedAt: Date,
  ): Promise<Player | null> {
    const document = await this.collection.findOneAndUpdate(
      { _id: id },
      { $set: { accountStatus: status, updatedAt } },
      { returnDocument: "after" },
    );
    return document ? toPlayer(document) : null;
  }
}
