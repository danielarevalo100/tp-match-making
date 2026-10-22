import type {
  GameModeInfo,
  LeaderboardBoard,
  LeaderboardStanding,
  PlayerSummary,
  RankingSlice,
  RankingWindow,
  SeasonInfo,
} from "../models/leaderboard.js";

/** Ranking ordenado (sorted sets de Redis): el único lugar que conoce las posiciones. */
export interface LeaderboardRankingPort {
  top(board: LeaderboardBoard, limit: number): Promise<RankingSlice>;
  /** Null cuando el jugador no está en ese tablero. */
  around(board: LeaderboardBoard, playerId: string, radius: number): Promise<RankingWindow | null>;
  /** Escribe los tableros global y regional; un standing con revisión más vieja se ignora. */
  publish(seasonId: string, mode: string, standings: readonly LeaderboardStanding[]): Promise<void>;
  listMembers(seasonId: string, mode: string): Promise<string[]>;
  remove(seasonId: string, mode: string, playerIds: readonly string[]): Promise<number>;
}

/** Catálogos, perfiles y los standings durables (MongoDB). */
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
  /** Todos los standings de la temporada y modo, en lotes. */
  listStandings(
    seasonId: string,
    mode: string,
    batchSize: number,
  ): AsyncIterable<LeaderboardStanding[]>;
}
