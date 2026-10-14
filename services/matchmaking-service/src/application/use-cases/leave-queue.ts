import { TicketNotFoundError } from "../../domain/errors/matchmaking-errors.js";
import type { MatchmakingQueue } from "../../domain/repositories/matchmaking-queue.js";

export class LeaveQueue {
  constructor(private readonly queue: MatchmakingQueue) {}

  async execute(playerId: string): Promise<void> {
    if (!(await this.queue.leave(playerId))) throw new TicketNotFoundError(playerId);
  }
}
