import type {
  AdministratorInfo,
  HeldBoard,
  HeldStanding,
  RatingReversal,
  ReportInfo,
  ReversalStep,
  ReversibleMatch,
  SanctionRecord,
  SeasonCatalog,
  SeasonStanding,
} from "../models/sanction.js";

/** Sanctions and the reversal journal (MongoDB `sanctions`), plus the reads that validate them. */
export interface SanctionRepositoryPort {
  find(sanctionId: string): Promise<SanctionRecord | null>;
  /** False when a sanction with the same id already exists (the request is a retry). */
  insert(sanction: SanctionRecord): Promise<boolean>;
  playerExists(playerId: string): Promise<boolean>;
  findAdministrator(administratorId: string): Promise<AdministratorInfo | null>;
  findReport(reportId: string): Promise<ReportInfo | null>;
  /** `pending | failed | reverting -> reverting`, counting the attempt. */
  beginReversal(sanctionId: string, at: Date): Promise<void>;
  /** Records a finished step; `hold` also records the boards it held. */
  markStep(
    sanctionId: string,
    step: ReversalStep,
    at: Date,
    heldBoards?: readonly HeldBoard[],
  ): Promise<void>;
  markMatchReverted(sanctionId: string, matchId: string, at: Date): Promise<void>;
  completeReversal(sanctionId: string, at: Date): Promise<void>;
  /** Only `reverting -> failed`: never degrades a reversal another attempt completed. */
  failReversal(sanctionId: string, message: string, at: Date): Promise<void>;
}

/** Matches, ratings and season standings (MongoDB `matches` and `players`). */
export interface ResultReversalPort {
  findMatches(matchIds: readonly string[]): Promise<ReversibleMatch[]>;
  /** Ranked modes and the seasons that already started (active or closed). */
  findSeasonCatalog(): Promise<SeasonCatalog>;
  /** `closed -> voided`. Idempotent: a match already voided (by any sanction) is left as it is. */
  voidMatch(matchId: string, sanctionId: string, at: Date): Promise<void>;
  /**
   * Subtracts the delta from the mode rating and from the affected season standings, once per
   * (match, player), and only if problem 4 had applied it.
   */
  revertRating(reversal: RatingReversal): Promise<void>;
  findStandings(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<SeasonStanding[]>;
}

/** Matchmaking queue (Redis): the same operation problem 1 uses to leave the queue. */
export interface SanctionQueuePort {
  /** True when the player was queued (or being placed in a match) and was removed. */
  leave(playerId: string): Promise<boolean>;
}

/** Player history (Cassandra `match_history_by_player`, problem 6). */
export interface HistoryCleanupPort {
  /** Deletes the match's row of each player. Idempotent. */
  deleteMatch(matchId: string, endedAt: Date, playerIds: readonly string[]): Promise<void>;
}

/** Co-participation graph (Neo4j, problem 7). */
export interface GraphCleanupPort {
  /** Deletes the match node and its PLAYED relationships. Idempotent. */
  deleteMatch(matchId: string): Promise<void>;
}

/** Season leaderboards (Redis sorted sets, problem 5). */
export interface ReversalLeaderboardPort {
  /** Publications of these players are skipped until they are released. Idempotent. */
  hold(seasonId: string, mode: string, holdId: string, playerIds: readonly string[]): Promise<void>;
  /** Releases the hold and writes the current standings, atomically for the whole board. */
  release(
    seasonId: string,
    mode: string,
    holdId: string,
    entries: readonly HeldStanding[],
  ): Promise<void>;
  /** Problem 5's revision-guarded publication; held players are skipped. */
  publish(seasonId: string, mode: string, standings: readonly SeasonStanding[]): Promise<void>;
}
