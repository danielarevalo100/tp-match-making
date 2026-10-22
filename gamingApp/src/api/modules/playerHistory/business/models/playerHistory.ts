import type {
  PlayerFinalScore,
  PlayerResult,
} from "../../../matchClosure/business/models/matchClosure.js";

/** Una partida del historial de un jugador (Cassandra `matches_by_player`). */
export type HistoryEntry = {
  deaths: number;
  endedAt: Date;
  kills: number;
  matchId: string;
  mmrAfter: number;
  mmrBefore: number;
  mode: string;
  objectives: number;
  ratingDelta: number;
  region: string;
  result: PlayerResult;
  score: number;
};

export type HistoryRow = HistoryEntry & { playerId: string };

export type PeriodWindow = { from: Date; to: Date };

export type RatingPoint = { endedAt: Date; mmr: number };

/** Rating de un modo en el período: dónde empezó, dónde terminó y los puntos intermedios. */
export type RatingEvolution = {
  change: number;
  from: number;
  mode: string;
  points: readonly RatingPoint[];
  to: number;
};

export type PeriodStats = {
  deaths: number;
  draws: number;
  from: Date;
  killDeathRatio: number | null;
  kills: number;
  losses: number;
  matches: number;
  ratingEvolution: readonly RatingEvolution[];
  to: Date;
  winRate: number | null;
  wins: number;
};

export type HistoryPlayer = {
  id: string;
  ratings: Readonly<Record<string, { mmr: number }>>;
  username: string;
};

export type ActiveSeason = { endsAt: Date; id: string; startsAt: Date };

export type PlayerHistoryView = {
  matches: readonly HistoryEntry[];
  player: HistoryPlayer;
  stats: {
    month: PeriodStats;
    season: (PeriodStats & { seasonId: string }) | null;
    week: PeriodStats;
  };
};

/** Una partida cerrada con su marcador final oficial (lo escribe el problema 4 en MongoDB). */
export type ClosedMatch = {
  endedAt: Date;
  id: string;
  mode: string;
  players: readonly PlayerFinalScore[];
  region: string;
};

export type ClosedMatchQuery = {
  afterId: string | null;
  limit: number;
  since?: Date;
};

export type ProjectionInput = {
  afterId: string | null;
  limit: number;
  since?: Date;
};

export type ProjectionResult = {
  matches: number;
  /** Pasarlo como `afterId` para continuar; `null` cuando no queda nada por proyectar. */
  nextCursor: string | null;
  rows: number;
};
