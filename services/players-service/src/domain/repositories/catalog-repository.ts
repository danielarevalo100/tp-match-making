export type GameMode = {
  id: string;
  initialRating: number;
};

export interface CatalogRepository {
  findActiveRegionByCountry(country: string): Promise<string | null>;
  listActiveGameModes(): Promise<readonly GameMode[]>;
}
