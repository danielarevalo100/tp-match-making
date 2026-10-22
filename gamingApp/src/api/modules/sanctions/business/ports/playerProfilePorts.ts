import type { LeaderboardRankingPort } from "../../../leaderboards/business/ports/leaderboardPorts.js";
import type { PlayerHistoryStorePort } from "../../../playerHistory/business/ports/playerHistoryPorts.js";
import type { ProfileDirectoryEntry, ProfileSanctionRecord } from "../models/playerProfile.js";

/** Perfil, ratings, standings de temporada y sanciones (MongoDB). */
export interface ProfileDirectoryPort {
  findPlayer(playerId: string): Promise<ProfileDirectoryEntry | null>;
  findActiveSeasonId(): Promise<string | null>;
  /** La más nueva primero. */
  findSanctions(playerId: string, limit: number): Promise<ProfileSanctionRecord[]>;
}

/** Las posiciones salen de los sorted sets del leaderboard (problema 5, Redis). */
export type ProfileRankingPort = Pick<LeaderboardRankingPort, "around">;

/** Las últimas partidas salen del historial (problema 6, Cassandra). */
export type ProfileHistoryPort = Pick<PlayerHistoryStorePort, "findLatest">;
