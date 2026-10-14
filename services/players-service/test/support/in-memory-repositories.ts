import type { Player } from "../../src/domain/entities/player.js";
import type { CatalogRepository, GameMode } from "../../src/domain/repositories/catalog-repository.js";
import type {
  PlayerPage,
  PlayerProfileChanges,
  PlayerRepository,
} from "../../src/domain/repositories/player-repository.js";
import type { Clock, IdGenerator, PasswordHasher } from "../../src/application/ports/system.js";

export class InMemoryPlayerRepository implements PlayerRepository {
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
      nextCursor: hasNextPage ? pageItems.at(-1)?.id ?? null : null,
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

  async updateStatus(
    id: string,
    status: Player["accountStatus"],
    updatedAt: Date,
  ): Promise<Player | null> {
    const index = this.items.findIndex((player) => player.id === id);
    const current = this.items[index];
    if (!current) return null;
    const updated = { ...current, accountStatus: status, updatedAt };
    this.items[index] = updated;
    return updated;
  }
}

export class InMemoryCatalogRepository implements CatalogRepository {
  private readonly regions = new Map([
    ["AR", "LATAM"],
    ["BR", "BR"],
  ]);

  private readonly modes: readonly GameMode[] = [
    { id: "ranked_1v1", initialRating: 1_000 },
    { id: "ranked_5v5", initialRating: 1_000 },
  ];

  async findActiveRegionByCountry(country: string): Promise<string | null> {
    return this.regions.get(country) ?? null;
  }

  async listActiveGameModes(): Promise<readonly GameMode[]> {
    return this.modes;
  }
}

export class FixedClock implements Clock {
  constructor(private readonly date: Date) {}
  now(): Date {
    return this.date;
  }
}

export class FixedIdGenerator implements IdGenerator {
  generate(): string {
    return "6a634799-3b19-4f68-9bc2-9d9c2ecf1938";
  }
}

export class FakePasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }
}
