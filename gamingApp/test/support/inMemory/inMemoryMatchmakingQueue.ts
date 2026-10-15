import type {
  EnqueueOutcome,
  QueueTicket,
} from "../../../src/api/modules/matchmaking/business/models/queueTicket.js";
import type { MatchmakingQueuePort } from "../../../src/api/modules/matchmaking/business/ports/matchmakingPorts.js";

export class InMemoryMatchmakingQueue implements MatchmakingQueuePort {
  readonly tickets = new Map<string, QueueTicket>();
  readonly activeMatches = new Map<string, string>();

  async enqueue(ticket: QueueTicket): Promise<EnqueueOutcome> {
    const existing = this.tickets.get(ticket.playerId);
    if (existing) {
      return {
        status: existing.ticketId === ticket.ticketId ? "replayed" : "already_in_queue",
        ticket: existing,
      };
    }
    const matchId = this.activeMatches.get(ticket.playerId);
    if (matchId) return { status: "already_in_match", matchId };
    this.tickets.set(ticket.playerId, ticket);
    return { status: "enqueued", ticket };
  }

  async findTicket(playerId: string): Promise<QueueTicket | null> {
    return this.tickets.get(playerId) ?? null;
  }

  async leave(playerId: string): Promise<boolean> {
    return this.tickets.delete(playerId);
  }
}
