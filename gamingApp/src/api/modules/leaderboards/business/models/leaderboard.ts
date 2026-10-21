export const leaderboardTopSize = 100;
export const leaderboardNeighbourCount = 5;

/** A season and mode board: global when `region` is null, otherwise that region's board. */
export type LeaderboardBoard = {
  mode: string;
  region: string | null;
  seasonId: string;
};

/** A player's standing as MongoDB stores it (`players.seasonRatings.<season>.<mode>`). */
export type LeaderboardStanding = {
  mmr: number;
  playerId: string;
  region: string;
  /** Grows on every change, so an older standing never overwrites a newer one. */
  revision: number;
};

/**
 * Position is ordinal (1-based) and follows Redis: higher MMR first, and players with the same
 * MMR ordered by descending player id, so equal ratings still get a stable, distinct position.
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

/** The player's position and the slice of neighbours around it. */
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

/** Profile data MongoDB adds to the ids and scores that come from Redis. */
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
  /** Up to five players right above, best first. */
  above: LeaderboardEntry[];
  /** Up to five players right below, best first. */
  below: LeaderboardEntry[];
  player: LeaderboardEntry;
};

export type LeaderboardRebuildResult = {
  mode: string;
  published: number;
  removed: number;
  seasonId: string;
};
