export type MatchLifecycleStatus = "in_progress" | "closing" | "closed" | "voided";

export type ScoringStatus = "not_started" | "pending" | "calculating" | "applied" | "failed";

/**
 * Publicación de los cambios de rating de la partida en el leaderboard de la temporada (problema
 * 5). Solo empieza cuando el scoring está `applied`, así un leaderboard nunca muestra un rating
 * que MongoDB o el marcador final todavía no tienen.
 */
export type LeaderboardStatus = "pending" | "published" | "not_ranked";

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
  /** Cuándo la formó el problema 2; decide la temporada para la que cuenta. */
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
  /** Rating desde el que se parte si el jugador todavía no tiene uno en el modo (el de la partida). */
  fallbackMmr: number;
  matchId: string;
  mode: string;
  playerId: string;
  /** Temporada cuyo standing también se actualiza, o null si la partida no es rankeada. */
  seasonId: string | null;
};

/** El lugar de un jugador en el leaderboard de una temporada, tal como lo guarda MongoDB. */
export type LeaderboardStanding = {
  mmr: number;
  playerId: string;
  region: string;
  /** Crece en cada cambio, así un standing viejo nunca pisa uno más nuevo. */
  revision: number;
};

export const ratingDeltaByResult: Readonly<Record<PlayerResult, number>> = {
  draw: 0,
  loss: -25,
  win: 25,
};
