import type {
  MatchLifecycleStatus,
  ScoringStatus,
} from "../../../matchClosure/business/models/matchClosure.js";

/** Same values as the `sanctions.type` validator; every type blocks matchmaking (problem 1). */
export const sanctionTypes = [
  "matchmaking_restriction",
  "temporary_suspension",
  "permanent_ban",
] as const;
export type SanctionType = (typeof sanctionTypes)[number];

export const sanctionStatuses = ["active", "expired", "revoked"] as const;
export type SanctionStatus = (typeof sanctionStatuses)[number];

/**
 * Reversal of the results of the matches the player cheated in. The sanction is registered first
 * and stays in force whatever happens to the reversal, which only ever moves forward:
 *
 *   pending -> reverting -> completed
 *                  |
 *                  +-----> failed -> reverting (retry or resume)
 */
export const reversalStatuses = ["pending", "reverting", "completed", "failed"] as const;
export type ReversalStatus = (typeof reversalStatuses)[number];

/**
 * Steps of the reversal recorded in the journal, in order. Matches are recorded one by one in
 * `revertedMatchIds`, between `hold` and `leaderboard`.
 */
export const reversalSteps = ["queue", "hold", "leaderboard"] as const;
export type ReversalStep = (typeof reversalSteps)[number];

/** A season and mode board and the players of the voided matches it has to hold. */
export type HeldBoard = {
  mode: string;
  playerIds: readonly string[];
  seasonId: string;
};

/** Durable checkpoint of the reversal, stored inside the sanction document. */
export type ReversalJournal = {
  attempts: number;
  completedAt: Date | null;
  completedSteps: readonly ReversalStep[];
  /** Boards held in Redis; the release step releases exactly these. */
  heldBoards: readonly HeldBoard[];
  lastError: string | null;
  revertedMatchIds: readonly string[];
  status: ReversalStatus;
  updatedAt: Date;
};

export type SanctionRecord = {
  administratorId: string;
  createdAt: Date;
  description: string | null;
  /** null = permanent. */
  endsAt: Date | null;
  id: string;
  /** Matches whose results are voided, as the administrator listed them. */
  matchIds: readonly string[];
  playerId: string;
  reason: string;
  reportId: string | null;
  reversal: ReversalJournal;
  startsAt: Date;
  status: SanctionStatus;
  type: SanctionType;
};

export type SanctionInput = {
  administratorId: string;
  description: string | null;
  endsAt: Date | null;
  matchIds: readonly string[];
  playerId: string;
  reason: string;
  reportId: string | null;
  /** Idempotency key chosen by the caller: the same id retried resumes the same sanction. */
  sanctionId: string;
  startsAt: Date | null;
  type: SanctionType;
};

export type AdministratorInfo = { active: boolean; id: string };
export type ReportInfo = { id: string; matchId: string | null; reportedPlayerId: string };

/** A participant's rating change that problem 4 applied and problem 8 takes back. */
export type ReversibleParticipant = {
  playerId: string;
  ratingDelta: number;
};

/** A match as problem 8 needs it: its final scoreboard and whether it is already voided. */
export type ReversibleMatch = {
  /** When problem 2 formed it; decides the season it counted for. */
  createdAt: Date;
  /** `closure.tsMs`: the `ended_at` of its rows in the player history (problem 6). */
  endedAt: Date | null;
  id: string;
  mode: string;
  /** From `finalScoreboard`; empty until problem 4 applied the scoring. */
  participants: readonly ReversibleParticipant[];
  scoringStatus: ScoringStatus;
  status: MatchLifecycleStatus;
  voidedBySanctionId: string | null;
};

export type CatalogSeason = {
  endsAt: Date;
  id: string;
  startsAt: Date;
  status: string;
};

/** What decides which season standings a match changed (MongoDB catalogs). */
export type SeasonCatalog = {
  rankedModes: readonly string[];
  seasons: readonly CatalogSeason[];
};

/**
 * Season standings a match changed. MMR does not reset between seasons, so a match shifts the
 * standing of its own season and of every later one the player has a standing in.
 */
export type AffectedSeasons = {
  /** Season that contains the match, whose `gamesPlayed` counted it. */
  matchSeasonId: string | null;
  /** That season and the later ones. Empty when the mode is not ranked. */
  seasonIds: readonly string[];
};

export type RatingReversal = {
  at: Date;
  /** The delta problem 4 applied; it is subtracted. */
  delta: number;
  matchId: string;
  matchSeasonId: string | null;
  mode: string;
  playerId: string;
  seasonIds: readonly string[];
};

/** A season standing as MongoDB stores it, with the games that still count. */
export type SeasonStanding = {
  gamesPlayed: number;
  mmr: number;
  playerId: string;
  region: string;
  revision: number;
};

/** A held player and its current standing in the board, or null when it has none. */
export type HeldStanding = {
  playerId: string;
  standing: SeasonStanding | null;
};

export type ReversalView = {
  attempts: number;
  completedAt: Date | null;
  completedSteps: readonly ReversalStep[];
  lastError: string | null;
  pendingMatchIds: readonly string[];
  revertedMatchIds: readonly string[];
  status: ReversalStatus;
};

export type SanctionView = {
  administratorId: string;
  createdAt: Date;
  description: string | null;
  endsAt: Date | null;
  matchIds: readonly string[];
  playerId: string;
  reason: string;
  reportId: string | null;
  reversal: ReversalView;
  sanctionId: string;
  startsAt: Date;
  status: SanctionStatus;
  type: SanctionType;
};

export type SanctionOutcome = {
  /** False when the request repeated a sanction that was already registered. */
  created: boolean;
  sanction: SanctionView;
};
