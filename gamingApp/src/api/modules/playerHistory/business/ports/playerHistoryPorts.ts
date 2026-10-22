import type {
  ActiveSeason,
  ClosedMatch,
  ClosedMatchQuery,
  HistoryEntry,
  HistoryPlayer,
  HistoryRow,
} from "../models/playerHistory.js";

/** Historial de partidas por jugador (Cassandra). */
export interface PlayerHistoryStorePort {
  /** Idempotente: una fila se identifica por (playerId, endedAt, matchId). */
  append(rows: readonly HistoryRow[]): Promise<void>;
  /** La más nueva primero. */
  findLatest(playerId: string, limit: number): Promise<HistoryEntry[]>;
  /** Todas las partidas desde `since`, la más nueva primero. */
  findSince(playerId: string, since: Date): Promise<HistoryEntry[]>;
}

/** Perfil del jugador y catálogo de temporadas (MongoDB). */
export interface PlayerDirectoryPort {
  findActiveSeason(): Promise<ActiveSeason | null>;
  findPlayer(playerId: string): Promise<HistoryPlayer | null>;
}

/** Partidas cerradas con su marcador final (MongoDB), en orden de `_id`. */
export interface ClosedMatchSourcePort {
  listClosedMatches(query: ClosedMatchQuery): Promise<ClosedMatch[]>;
}
