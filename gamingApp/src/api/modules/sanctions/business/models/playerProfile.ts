import type { HistoryEntry } from "../../../playerHistory/business/models/playerHistory.js";
import type { ReversalStatus, SanctionStatus, SanctionType } from "./sanction.js";

export const defaultProfileMatches = 10;
export const maxProfileMatches = 50;
export const maxProfileSanctions = 20;

export type ProfilePlayer = {
  accountStatus: string;
  country: string;
  id: string;
  level: number;
  region: string;
  registeredAt: Date;
  username: string;
};

export type ProfileRating = {
  gamesPlayed: number;
  mmr: number;
  mode: string;
};

export type ProfileStanding = {
  gamesPlayed: number;
  mmr: number;
  mode: string;
  region: string;
  seasonId: string;
};

/** What MongoDB knows about the player: profile, rating per mode and season standings. */
export type ProfileDirectoryEntry = {
  player: ProfilePlayer;
  ratings: readonly ProfileRating[];
  standings: readonly ProfileStanding[];
};

export type ProfileSanctionRecord = {
  endsAt: Date | null;
  reason: string;
  reversalStatus: ReversalStatus | null;
  sanctionId: string;
  startsAt: Date;
  status: SanctionStatus;
  type: SanctionType;
  voidedMatches: number;
};

export type ProfileSanction = ProfileSanctionRecord & {
  /** Same rule problem 1 applies: active, already started and not yet ended. */
  inForce: boolean;
};

export type BoardPosition = {
  position: number;
  totalPlayers: number;
};

/** Position read from Redis now; null when the player is not in that board. */
export type ProfileLeaderboard = {
  gamesPlayed: number;
  global: BoardPosition | null;
  mmr: number;
  mode: string;
  region: string;
  regional: BoardPosition | null;
  seasonId: string;
};

export type PlayerProfile = {
  /** Positions in the active season's boards, one per ranked mode the player played. */
  leaderboards: readonly ProfileLeaderboard[];
  player: ProfilePlayer;
  ratings: readonly ProfileRating[];
  /** Newest first, from the player history (problem 6); voided matches are not there. */
  recentMatches: readonly HistoryEntry[];
  sanctions: readonly ProfileSanction[];
  seasonId: string | null;
};
