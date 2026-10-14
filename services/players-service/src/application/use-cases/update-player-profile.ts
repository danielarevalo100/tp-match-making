import { toPublicPlayer, type PublicPlayer } from "../../domain/entities/player.js";
import {
  PlayerConflictError,
  PlayerNotFoundError,
  RegionNotFoundError,
} from "../../domain/errors/player-errors.js";
import type { CatalogRepository } from "../../domain/repositories/catalog-repository.js";
import type {
  PlayerProfileChanges,
  PlayerRepository,
} from "../../domain/repositories/player-repository.js";
import type { Clock } from "../ports/system.js";

export type UpdatePlayerProfileInput = {
  avatarUrl?: string | null | undefined;
  birthDate?: Date | null | undefined;
  country?: string | undefined;
  email?: string | undefined;
  username?: string | undefined;
};

export class UpdatePlayerProfile {
  constructor(
    private readonly players: PlayerRepository,
    private readonly catalogs: CatalogRepository,
    private readonly clock: Clock,
  ) {}

  async execute(playerId: string, input: UpdatePlayerProfileInput): Promise<PublicPlayer> {
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

    const updated = await this.players.updateProfile(playerId, changes, this.clock.now());
    if (!updated) throw new PlayerNotFoundError(playerId);
    return toPublicPlayer(updated);
  }
}
