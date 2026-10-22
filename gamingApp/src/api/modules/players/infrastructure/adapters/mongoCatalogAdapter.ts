import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type { GameMode } from "../../business/models/player.js";
import type { CatalogRepositoryPort } from "../../business/ports/playersPorts.js";

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

export class MongoCatalogAdapter extends BaseMongoAdapter implements CatalogRepositoryPort {
  private readonly regions: Collection<RegionDocument>;
  private readonly gameModes: Collection<GameModeDocument>;

  constructor(database: Db) {
    super(database);
    this.regions = database.collection<RegionDocument>(mongoCollections.regions);
    this.gameModes = database.collection<GameModeDocument>(mongoCollections.gameModes);
  }

  findActiveRegionByCountry(country: string): Promise<string | null> {
    return this.read(async () => {
      const region = await this.regions.findOne({ active: true, countries: country });
      return region?._id ?? null;
    });
  }

  listActiveGameModes(): Promise<readonly GameMode[]> {
    return this.read(async () => {
      const modes = await this.gameModes.find({ active: true }).sort({ _id: 1 }).toArray();
      return modes.map((mode) => ({
        id: mode._id,
        initialRating: mode.initialRating ?? 1_000,
      }));
    });
  }
}
