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
  eventId: string | null;
  id: string;
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

export const ratingDeltaByResult: Readonly<Record<PlayerResult, number>> = {
  draw: 0,
  loss: -25,
  win: 25,
};
