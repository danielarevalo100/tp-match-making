import type {
  GameModeInfo,
  LeaderboardBoard,
  LeaderboardStanding,
  PlayerSummary,
  RankingSlice,
  RankingWindow,
  SeasonInfo,
} from "../models/leaderboard.js";

/** Ordered ranking (Redis sorted sets): the only place that knows positions. */
export interface LeaderboardRankingPort {
  top(board: LeaderboardBoard, limit: number): Promise<RankingSlice>;
  /** Null when the player is not in that board. */
  around(board: LeaderboardBoard, playerId: string, radius: number): Promise<RankingWindow | null>;
  /** Writes the global and regional boards; a standing with an older revision is ignored. */
  publish(seasonId: string, mode: string, standings: readonly LeaderboardStanding[]): Promise<void>;
  listMembers(seasonId: string, mode: string): Promise<string[]>;
  remove(seasonId: string, mode: string, playerIds: readonly string[]): Promise<number>;
}

/** Catalogs, profiles and the durable standings (MongoDB). */
export interface LeaderboardDirectoryPort {
  findSeason(seasonId: string): Promise<SeasonInfo | null>;
  findMode(mode: string): Promise<GameModeInfo | null>;
  regionExists(region: string): Promise<boolean>;
  findPlayers(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<ReadonlyMap<string, PlayerSummary>>;
  findStandings(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<LeaderboardStanding[]>;
  /** Every standing of the season and mode, in batches. */
  listStandings(
    seasonId: string,
    mode: string,
    batchSize: number,
  ): AsyncIterable<LeaderboardStanding[]>;
}
