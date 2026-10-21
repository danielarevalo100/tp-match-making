export const matchLifecycleStatuses = ["in_progress", "closing", "closed", "voided"] as const;
export type MatchLifecycleStatus = (typeof matchLifecycleStatuses)[number];

export const scoringStatuses = [
  "not_started",
  "pending",
  "calculating",
  "applied",
  "failed",
] as const;
export type ScoringStatus = (typeof scoringStatuses)[number];

/**
 * Publication of the match's rating changes to the season leaderboard (problem 5). It only
 * starts once scoring is `applied`, so a leaderboard never shows a rating that MongoDB or the
 * final scoreboard do not have yet.
 */
export const leaderboardStatuses = ["pending", "published", "not_ranked"] as const;
export type LeaderboardStatus = (typeof leaderboardStatuses)[number];

export const finishReasons = ["normal", "forfeit", "administrative"] as const;
export type FinishReason = (typeof finishReasons)[number];

export const playerResults = ["win", "loss", "draw"] as const;
export type PlayerResult = (typeof playerResults)[number];

export type DeclaredPlayerResult = {
  playerId: string;
  result: PlayerResult;
};

export type MatchParticipant = {
  enqueuedAt: number;
  mmr: number;
  playerId: string;
};

export type MatchClosureRecord = {
  closureId: string | null;
  /** When problem 2 formed the match; decides the season the match counts for. */
  createdAt: Date;
  eventId: string | null;
  id: string;
  leaderboardStatus: LeaderboardStatus;
  mode: string;
  players: readonly MatchParticipant[];
  results: readonly DeclaredPlayerResult[] | null;
  scoringStatus: ScoringStatus;
  status: MatchLifecycleStatus;
};

export type FinishMatchInput = {
  closureId: string;
  eventId: string;
  matchId: string;
  reason: FinishReason;
  results: readonly DeclaredPlayerResult[];
  tsMs: number;
};

export type MatchFinishedEvent = FinishMatchInput & {
  type: "match_finished";
};

export type RedisClosingOutcome = "closing" | "replayed" | "released";
export type RedisReleaseOutcome = "released" | "already_released";

export type PlayerFinalScore = {
  deaths: number;
  kills: number;
  mmrAfter: number;
  mmrBefore: number;
  objectives: number;
  playerId: string;
  ratingDelta: number;
  result: PlayerResult;
  score: number;
};

export type FinishMatchResult = {
  closureId: string;
  leaderboardStatus: LeaderboardStatus;
  matchId: string;
  playersReleased: true;
  scoringStatus: ScoringStatus;
  status: "closed";
};

export type ScoringEvent = {
  playerId: string;
  points: number;
  targetPlayerId: string | null;
  type: "kill" | "objective" | "disconnect" | "reconnect";
};

export type ScoringEventPage = {
  events: readonly ScoringEvent[];
  nextPageState: string | null;
};

export type ApplyRatingInput = {
  at: Date;
  delta: number;
  /** Rating to start from when the player has none for the mode yet (the match snapshot). */
  fallbackMmr: number;
  matchId: string;
  mode: string;
  playerId: string;
  /** Season whose leaderboard standing is updated too, or null when the match is not ranked. */
  seasonId: string | null;
};

/** A player's place in a season leaderboard, as stored in MongoDB. */
export type LeaderboardStanding = {
  mmr: number;
  playerId: string;
  region: string;
  /** Grows on every change, so an older standing never overwrites a newer one. */
  revision: number;
};

export const ratingDeltaByResult: Readonly<Record<PlayerResult, number>> = {
  draw: 0,
  loss: -25,
  win: 25,
};
