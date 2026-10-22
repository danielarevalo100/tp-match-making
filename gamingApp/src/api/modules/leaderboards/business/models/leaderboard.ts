export const leaderboardTopSize = 100;
export const leaderboardNeighbourCount = 5;

/** Tablero de una temporada y modo: global si `region` es null, si no el de esa región. */
export type LeaderboardBoard = {
  mode: string;
  region: string | null;
  seasonId: string;
};

/** Standing de un jugador tal como lo guarda MongoDB (`players.seasonRatings.<season>.<mode>`). */
export type LeaderboardStanding = {
  mmr: number;
  playerId: string;
  region: string;
  /** Crece en cada cambio, así un standing viejo nunca pisa uno más nuevo. */
  revision: number;
};

/**
 * La posición es ordinal (desde 1) y sigue a Redis: primero el MMR más alto, y a igual MMR por
 * playerId descendente, así ratings iguales igual tienen una posición estable y distinta.
 */
export type RankedPlayer = {
  mmr: number;
  playerId: string;
  position: number;
};

export type RankingSlice = {
  entries: readonly RankedPlayer[];
  totalPlayers: number;
};

/** La posición del jugador y los vecinos que tiene alrededor. */
export type RankingWindow = RankingSlice & {
  position: number;
};

export type SeasonInfo = {
  id: string;
  status: string;
};

export type GameModeInfo = {
  id: string;
  ranked: boolean;
};

/** Datos de perfil que MongoDB agrega a los ids y puntajes que vienen de Redis. */
export type PlayerSummary = {
  country: string;
  gamesPlayed: number | null;
  region: string | null;
  username: string;
};

export type LeaderboardEntry = RankedPlayer & {
  country: string | null;
  gamesPlayed: number | null;
  region: string | null;
  username: string | null;
};

export type LeaderboardHeader = {
  mode: string;
  region: string | null;
  scope: "global" | "regional";
  seasonId: string;
  seasonStatus: string;
  totalPlayers: number;
};

export type LeaderboardTop = LeaderboardHeader & {
  entries: LeaderboardEntry[];
};

export type LeaderboardPosition = LeaderboardHeader & {
  /** Hasta cinco jugadores justo arriba, el mejor primero. */
  above: LeaderboardEntry[];
  /** Hasta cinco jugadores justo abajo, el mejor primero. */
  below: LeaderboardEntry[];
  player: LeaderboardEntry;
};

export type LeaderboardRebuildResult = {
  mode: string;
  published: number;
  removed: number;
  seasonId: string;
};
