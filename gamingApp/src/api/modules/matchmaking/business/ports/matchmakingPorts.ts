import type {
  EligiblePlayer,
  EnqueueOutcome,
  QueueMode,
  QueueTicket,
  SanctionInForce,
} from "../models/queueTicket.js";

export interface EligibilityRepositoryPort {
  findActiveMode(modeId: string): Promise<QueueMode | null>;
  findPlayer(playerId: string): Promise<EligiblePlayer | null>;
  findSanctionInForce(playerId: string, at: Date): Promise<SanctionInForce | null>;
  isActiveRegion(regionId: string): Promise<boolean>;
}

export interface MatchmakingQueuePort {
  enqueue(ticket: QueueTicket): Promise<EnqueueOutcome>;
  findTicket(playerId: string): Promise<QueueTicket | null>;
  leave(playerId: string): Promise<boolean>;
}
