import type {
  ActiveSeason,
  ClosedMatch,
  ClosedMatchQuery,
  HistoryEntry,
  HistoryPlayer,
  HistoryRow,
} from "../models/playerHistory.js";

/** Per-player match history (Cassandra). */
export interface PlayerHistoryStorePort {
  /** Idempotent: a row is identified by (playerId, endedAt, matchId). */
  append(rows: readonly HistoryRow[]): Promise<void>;
  /** Newest first. */
  findLatest(playerId: string, limit: number): Promise<HistoryEntry[]>;
  /** Every match since `since`, newest first. */
  findSince(playerId: string, since: Date): Promise<HistoryEntry[]>;
}

/** Player profile and season catalog (MongoDB). */
export interface PlayerDirectoryPort {
  findActiveSeason(): Promise<ActiveSeason | null>;
  findPlayer(playerId: string): Promise<HistoryPlayer | null>;
}

/** Closed matches with their final scoreboard (MongoDB), in `_id` order. */
export interface ClosedMatchSourcePort {
  listClosedMatches(query: ClosedMatchQuery): Promise<ClosedMatch[]>;
}
