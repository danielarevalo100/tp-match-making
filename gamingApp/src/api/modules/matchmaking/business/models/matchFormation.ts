import type { QueueTicket } from "./queueTicket.js";

export type FormationMode = {
  expandEverySeconds: number;
  id: string;
  initialRatingRange: number;
  maxPlayers: number;
  maxRatingRange: number;
  minPlayers: number;
  ratingRangeStep: number;
};

export type MatchRecord = {
  createdAt: Date;
  id: string;
  mode: string;
  players: readonly { enqueuedAt: number; mmr: number; playerId: string }[];
  ratingRange: number;
  region: string;
};

export type ReserveOutcome =
  | { status: "reserved" }
  // Tickets that were no longer in the queue; nothing was written.
  | { status: "missing"; playerIds: readonly string[] };

export type CommitOutcome = { status: "committed" } | { status: "abandoned" };

export type RestoreOutcome = {
  // Players put back in the queue with their original enqueuedAt.
  restored: readonly string[];
  status: "rolled_back" | "already_rolled_back" | "not_found" | "committed";
};

export type FormationInput = {
  mode: string;
  region: string;
};

export type FormationResult =
  | { matchId: string; players: readonly QueueTicket[]; ratingRange: number; status: "formed" }
  | { queued: number; ratingRange: number; required: number; status: "not_enough_players" }
  | {
      matchId: string;
      reason: "player_left";
      restored: readonly string[];
      status: "rolled_back";
    };

export type RecoveryResult = {
  recovered: readonly { matchId: string; restored: readonly string[] }[];
};
