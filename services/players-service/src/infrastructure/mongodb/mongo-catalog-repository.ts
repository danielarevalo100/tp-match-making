import type { Collection } from "mongodb";

import type {
  CatalogRepository,
  GameMode,
} from "../../domain/repositories/catalog-repository.js";

type RegionDocument = {
  _id: string;
  active: boolean;
  countries: string[];
};

type GameModeDocument = {
  _id: string;
  active: boolean;
  initialRating?: number;
};

export class MongoCatalogRepository implements CatalogRepository {
  constructor(
    private readonly regions: Collection<RegionDocument>,
    private readonly gameModes: Collection<GameModeDocument>,
  ) {}

  async findActiveRegionByCountry(country: string): Promise<string | null> {
    const region = await this.regions.findOne({ active: true, countries: country });
    return region?._id ?? null;
  }

  async listActiveGameModes(): Promise<readonly GameMode[]> {
    const modes = await this.gameModes.find({ active: true }).sort({ _id: 1 }).toArray();
    return modes.map((mode) => ({
      id: mode._id,
      initialRating: mode.initialRating ?? 1_000,
    }));
  }
}
