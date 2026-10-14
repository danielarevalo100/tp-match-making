import type { QueueTicket } from "../entities/queue-ticket.js";

export type EnqueueOutcome =
  | { status: "enqueued"; ticket: QueueTicket }
  | { status: "replayed"; ticket: QueueTicket }
  | { status: "already_in_queue"; ticket: QueueTicket }
  | { status: "already_in_match"; matchId: string };

// Live matchmaking state. `enqueue` must check "not already queued" and "no
// active match" and write the ticket as one atomic step.
export interface MatchmakingQueue {
  enqueue(ticket: QueueTicket): Promise<EnqueueOutcome>;
  findTicket(playerId: string): Promise<QueueTicket | null>;
  leave(playerId: string): Promise<boolean>;
}
