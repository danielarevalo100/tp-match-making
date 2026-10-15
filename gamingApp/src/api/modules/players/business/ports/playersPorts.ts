import type {
  AccountStatus,
  GameMode,
  Player,
  PlayerPage,
  PlayerProfileChanges,
} from "../models/player.js";

export interface PlayersRepositoryPort {
  create(player: Player): Promise<void>;
  findByEmail(email: string): Promise<Player | null>;
  findById(id: string): Promise<Player | null>;
  findByUsername(username: string): Promise<Player | null>;
  list(cursor: string | null, limit: number): Promise<PlayerPage>;
  updateProfile(id: string, changes: PlayerProfileChanges, updatedAt: Date): Promise<Player | null>;
  updateStatus(id: string, status: AccountStatus, updatedAt: Date): Promise<Player | null>;
}

export interface CatalogRepositoryPort {
  findActiveRegionByCountry(country: string): Promise<string | null>;
  listActiveGameModes(): Promise<readonly GameMode[]>;
}
