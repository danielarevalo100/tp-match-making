import type {
  AccountStatus,
  Player,
  PlayerPage,
  PlayerProfileChanges,
} from "../../../src/api/modules/players/business/models/player.js";
import type { PlayersRepositoryPort } from "../../../src/api/modules/players/business/ports/playersPorts.js";

export class InMemoryPlayersRepository implements PlayersRepositoryPort {
  readonly items: Player[] = [];

  async create(player: Player): Promise<void> {
    this.items.push(player);
  }

  async findByEmail(email: string): Promise<Player | null> {
    return this.items.find((player) => player.email === email) ?? null;
  }

  async findById(id: string): Promise<Player | null> {
    return this.items.find((player) => player.id === id) ?? null;
  }

  async findByUsername(username: string): Promise<Player | null> {
    return this.items.find((player) => player.username === username) ?? null;
  }

  async list(cursor: string | null, limit: number): Promise<PlayerPage> {
    const sorted = [...this.items].sort((left, right) => left.id.localeCompare(right.id));
    const startIndex = cursor ? sorted.findIndex((player) => player.id === cursor) + 1 : 0;
    const pageItems = sorted.slice(startIndex, startIndex + limit);
    const hasNextPage = startIndex + limit < sorted.length;
    return {
      items: pageItems,
      nextCursor: hasNextPage ? (pageItems.at(-1)?.id ?? null) : null,
    };
  }

  async updateProfile(
    id: string,
    changes: PlayerProfileChanges,
    updatedAt: Date,
  ): Promise<Player | null> {
    const index = this.items.findIndex((player) => player.id === id);
    const current = this.items[index];
    if (!current) return null;

    const updated: Player = {
      ...current,
      ...(changes.username === undefined ? {} : { username: changes.username }),
      ...(changes.email === undefined ? {} : { email: changes.email }),
      ...(changes.country === undefined ? {} : { country: changes.country }),
      ...(changes.region === undefined ? {} : { region: changes.region }),
      updatedAt,
    };

    if (changes.avatarUrl === null) delete updated.avatarUrl;
    else if (changes.avatarUrl !== undefined) updated.avatarUrl = changes.avatarUrl;

    if (changes.birthDate === null) delete updated.birthDate;
    else if (changes.birthDate !== undefined) updated.birthDate = changes.birthDate;

    this.items[index] = updated;
    return updated;
  }

  async updateStatus(id: string, status: AccountStatus, updatedAt: Date): Promise<Player | null> {
    const index = this.items.findIndex((player) => player.id === id);
    const current = this.items[index];
    if (!current) return null;
    const updated = { ...current, accountStatus: status, updatedAt };
    this.items[index] = updated;
    return updated;
  }
}
