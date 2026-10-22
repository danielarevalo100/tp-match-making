import type {
  CommitOutcome,
  FormationMode,
  MatchRecord,
  RestoreOutcome,
  ReserveOutcome,
} from "../models/matchFormation.js";
import type {
  EligiblePlayer,
  EnqueueOutcome,
  QueueMode,
  QueueTicket,
  SanctionInForce,
} from "../models/queueTicket.js";

export interface EligibilityRepositoryPort {
  findActiveMode(modeId: string): Promise<QueueMode | null>;
  findFormationMode(modeId: string): Promise<FormationMode | null>;
  findPlayer(playerId: string): Promise<EligiblePlayer | null>;
  findSanctionInForce(playerId: string, at: Date): Promise<SanctionInForce | null>;
  isActiveRegion(regionId: string): Promise<boolean>;
}

export interface MatchmakingQueuePort {
  enqueue(ticket: QueueTicket): Promise<EnqueueOutcome>;
  findTicket(playerId: string): Promise<QueueTicket | null>;
  leave(playerId: string): Promise<boolean>;

  // Formación de partidas (problema 2).
  findOldestTicket(mode: string, region: string): Promise<QueueTicket | null>;
  findTicketsInRatingRange(
    mode: string,
    region: string,
    minMmr: number,
    maxMmr: number,
    limit: number,
  ): Promise<QueueTicket[]>;
  /** Mueve los tickets de la cola a una formación `reserved`, de forma atómica. */
  reserveFormation(matchId: string, tickets: readonly QueueTicket[]): Promise<ReserveOutcome>;
  /** Último paso: publica la partida en vivo y cierra la formación. Idempotente. */
  commitFormation(
    matchId: string,
    mode: string,
    region: string,
    playerIds: readonly string[],
  ): Promise<CommitOutcome>;
  /** Compensación: devuelve los tickets reservados con su enqueuedAt original. Idempotente. */
  restoreFormation(matchId: string): Promise<RestoreOutcome>;
  findStaleFormations(olderThanMs: number): Promise<string[]>;
}

export interface MatchRepositoryPort {
  create(match: MatchRecord): Promise<void>;
  delete(matchId: string): Promise<void>;
}
