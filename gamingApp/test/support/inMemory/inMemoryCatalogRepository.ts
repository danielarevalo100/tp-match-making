import type { GameMode } from "../../../src/api/modules/players/business/models/player.js";
import type { CatalogRepositoryPort } from "../../../src/api/modules/players/business/ports/playersPorts.js";

export class InMemoryCatalogRepository implements CatalogRepositoryPort {
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
