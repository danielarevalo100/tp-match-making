import { randomUUID } from "node:crypto";

import { hashPassword } from "../../../../../shared/password.js";
import {
  toPublicPlayer,
  type AccountStatus,
  type Player,
  type PlayerProfileChanges,
  type PublicPlayer,
  type PublicPlayerPage,
} from "../models/player.js";
import {
  PlayerConflictError,
  PlayerNotFoundError,
  RegionNotFoundError,
} from "../models/playerErrors.js";
import type { CatalogRepositoryPort, PlayersRepositoryPort } from "../ports/playersPorts.js";

export type RegisterPlayerInput = {
  avatarUrl?: string | undefined;
  birthDate?: Date | undefined;
  country: string;
  email: string;
  password: string;
  username: string;
};

export type UpdatePlayerProfileInput = {
  avatarUrl?: string | null | undefined;
  birthDate?: Date | null | undefined;
  country?: string | undefined;
  email?: string | undefined;
  username?: string | undefined;
};

export type ListPlayersInput = {
  cursor: string | null;
  limit: number;
};

export class PlayersService {
  constructor(
    private readonly players: PlayersRepositoryPort,
    private readonly catalogs: CatalogRepositoryPort,
  ) {}

  async register(input: RegisterPlayerInput): Promise<PublicPlayer> {
    const username = input.username.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    const country = input.country.trim().toUpperCase();

    const [existingUsername, existingEmail, region, gameModes] = await Promise.all([
      this.players.findByUsername(username),
      this.players.findByEmail(email),
      this.catalogs.findActiveRegionByCountry(country),
      this.catalogs.listActiveGameModes(),
    ]);

    if (existingUsername) throw new PlayerConflictError("username");
    if (existingEmail) throw new PlayerConflictError("email");
    if (!region) throw new RegionNotFoundError(country);

    const now = new Date();
    const ratings = Object.fromEntries(
      gameModes.map((mode) => [
        mode.id,
        { gamesPlayed: 0, mmr: mode.initialRating, updatedAt: now },
      ]),
    );

    const player: Player = {
      accountStatus: "active",
      country,
      email,
      id: randomUUID(),
      level: 1,
      passwordHash: await hashPassword(input.password),
      ratings,
      region,
      registeredAt: now,
      updatedAt: now,
      username,
      ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
      ...(input.birthDate === undefined ? {} : { birthDate: input.birthDate }),
    };

    await this.players.create(player);
    return toPublicPlayer(player);
  }

  async getById(playerId: string): Promise<PublicPlayer> {
    const player = await this.players.findById(playerId);
    if (!player) throw new PlayerNotFoundError(playerId);
    return toPublicPlayer(player);
  }

  async list(input: ListPlayersInput): Promise<PublicPlayerPage> {
    const page = await this.players.list(input.cursor, input.limit);
    return {
      items: page.items.map(toPublicPlayer),
      nextCursor: page.nextCursor,
    };
  }

  async updateProfile(playerId: string, input: UpdatePlayerProfileInput): Promise<PublicPlayer> {
    const current = await this.players.findById(playerId);
    if (!current) throw new PlayerNotFoundError(playerId);

    const changes: PlayerProfileChanges = {};

    if (input.username !== undefined) {
      const username = input.username.trim().toLowerCase();
      const owner = await this.players.findByUsername(username);
      if (owner && owner.id !== playerId) throw new PlayerConflictError("username");
      changes.username = username;
    }

    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      const owner = await this.players.findByEmail(email);
      if (owner && owner.id !== playerId) throw new PlayerConflictError("email");
      changes.email = email;
    }

    if (input.country !== undefined) {
      const country = input.country.trim().toUpperCase();
      const region = await this.catalogs.findActiveRegionByCountry(country);
      if (!region) throw new RegionNotFoundError(country);
      changes.country = country;
      changes.region = region;
    }

    if (input.avatarUrl !== undefined) changes.avatarUrl = input.avatarUrl;
    if (input.birthDate !== undefined) changes.birthDate = input.birthDate;

    const updated = await this.players.updateProfile(playerId, changes, new Date());
    if (!updated) throw new PlayerNotFoundError(playerId);
    return toPublicPlayer(updated);
  }

  async updateStatus(playerId: string, status: AccountStatus): Promise<PublicPlayer> {
    const updated = await this.players.updateStatus(playerId, status, new Date());
    if (!updated) throw new PlayerNotFoundError(playerId);
    return toPublicPlayer(updated);
  }
}
