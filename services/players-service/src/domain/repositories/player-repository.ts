import type { AccountStatus, Player } from "../entities/player.js";

export type PlayerPage = {
  items: readonly Player[];
  nextCursor: string | null;
};

export type PlayerProfileChanges = {
  avatarUrl?: string | null;
  birthDate?: Date | null;
  country?: string;
  email?: string;
  region?: string;
  username?: string;
};

export interface PlayerRepository {
  create(player: Player): Promise<void>;
  findByEmail(email: string): Promise<Player | null>;
  findById(id: string): Promise<Player | null>;
  findByUsername(username: string): Promise<Player | null>;
  list(cursor: string | null, limit: number): Promise<PlayerPage>;
  updateProfile(id: string, changes: PlayerProfileChanges, updatedAt: Date): Promise<Player | null>;
  updateStatus(id: string, status: AccountStatus, updatedAt: Date): Promise<Player | null>;
}
