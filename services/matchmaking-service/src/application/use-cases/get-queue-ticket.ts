import type { QueueTicket } from "../../domain/entities/queue-ticket.js";
import { TicketNotFoundError } from "../../domain/errors/matchmaking-errors.js";
import type { MatchmakingQueue } from "../../domain/repositories/matchmaking-queue.js";

export class GetQueueTicket {
  constructor(private readonly queue: MatchmakingQueue) {}

  async execute(playerId: string): Promise<QueueTicket> {
    const ticket = await this.queue.findTicket(playerId);
    if (!ticket) throw new TicketNotFoundError(playerId);
    return ticket;
  }
}
