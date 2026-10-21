import type { LeaderboardRankingPort } from "../../../leaderboards/business/ports/leaderboardPorts.js";
import type { PlayerHistoryStorePort } from "../../../playerHistory/business/ports/playerHistoryPorts.js";
import type { ProfileDirectoryEntry, ProfileSanctionRecord } from "../models/playerProfile.js";

/** Profile, ratings, season standings and sanctions (MongoDB). */
export interface ProfileDirectoryPort {
  findPlayer(playerId: string): Promise<ProfileDirectoryEntry | null>;
  findActiveSeasonId(): Promise<string | null>;
  /** Newest first. */
  findSanctions(playerId: string, limit: number): Promise<ProfileSanctionRecord[]>;
}

/** Positions come from the leaderboard sorted sets (problem 5, Redis). */
export type ProfileRankingPort = Pick<LeaderboardRankingPort, "around">;

/** Latest matches come from the player history (problem 6, Cassandra). */
export type ProfileHistoryPort = Pick<PlayerHistoryStorePort, "findLatest">;
