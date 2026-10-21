import { MongoServerError } from "mongodb";

import type { AccountStatus, Player, PlayerRating } from "../../business/models/player.js";
import { PlayerConflictError } from "../../business/models/playerErrors.js";

export type PlayerDocument = {
  _id: string;
  accountStatus: AccountStatus;
  avatarUrl?: string;
  birthDate?: Date;
  country: string;
  email: string;
  level: number;
  passwordHash: string;
  ratings: Record<string, PlayerRating>;
  region: string;
  registeredAt: Date;
  updatedAt: Date;
  username: string;
};

export function toConflictError(error: unknown): PlayerConflictError | null {
  if (!(error instanceof MongoServerError) || error.code !== 11_000) return null;
  return new PlayerConflictError(error.message.includes("email_1") ? "email" : "username");
}

export function toPlayerDocument(player: Player): PlayerDocument {
  return {
    _id: player.id,
    accountStatus: player.accountStatus,
    country: player.country,
    email: player.email,
    level: player.level,
    passwordHash: player.passwordHash,
    ratings: { ...player.ratings },
    region: player.region,
    registeredAt: player.registeredAt,
    updatedAt: player.updatedAt,
    username: player.username,
    ...(player.avatarUrl === undefined ? {} : { avatarUrl: player.avatarUrl }),
    ...(player.birthDate === undefined ? {} : { birthDate: player.birthDate }),
  };
}

export function toPlayer(document: PlayerDocument): Player {
  return {
    accountStatus: document.accountStatus,
    country: document.country,
    email: document.email,
    id: document._id,
    level: document.level,
    passwordHash: document.passwordHash,
    ratings: document.ratings,
    region: document.region,
    registeredAt: document.registeredAt,
    updatedAt: document.updatedAt,
    username: document.username,
    ...(document.avatarUrl === undefined ? {} : { avatarUrl: document.avatarUrl }),
    ...(document.birthDate === undefined ? {} : { birthDate: document.birthDate }),
  };
}
