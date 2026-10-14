// Read-only view of the durable data (MongoDB) needed to decide whether a
// player may join a queue. Problem 1 never writes to MongoDB.

export type EligiblePlayer = {
  accountStatus: string;
  id: string;
  ratings: Readonly<Record<string, { mmr: number }>>;
  region: string;
};

export type QueueMode = {
  id: string;
  initialRating: number;
};

export type SanctionInForce = {
  endsAt: Date | null;
  id: string;
  type: string;
};

export interface EligibilityRepository {
  findActiveMode(modeId: string): Promise<QueueMode | null>;
  findPlayer(playerId: string): Promise<EligiblePlayer | null>;
  findSanctionInForce(playerId: string, at: Date): Promise<SanctionInForce | null>;
  isActiveRegion(regionId: string): Promise<boolean>;
}
