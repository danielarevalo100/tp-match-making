import type { Request, Response } from "express";

import type { EnqueuePlayer } from "../../../application/use-cases/enqueue-player.js";
import type { GetQueueTicket } from "../../../application/use-cases/get-queue-ticket.js";
import type { LeaveQueue } from "../../../application/use-cases/leave-queue.js";
import { enqueueSchema, playerIdParamSchema } from "../schemas/queue-schemas.js";

export class QueueController {
  constructor(
    private readonly enqueuePlayer: EnqueuePlayer,
    private readonly getQueueTicket: GetQueueTicket,
    private readonly leaveQueue: LeaveQueue,
  ) {}

  // 201 when the ticket is created, 200 when the same ticketId is replayed.
  readonly enqueue = async (request: Request, response: Response): Promise<void> => {
    const input = enqueueSchema.parse(request.body as unknown);
    const { created, ticket } = await this.enqueuePlayer.execute(input);
    response.status(created ? 201 : 200).json(ticket);
  };

  readonly getTicket = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdParamSchema.parse(request.params);
    response.json(await this.getQueueTicket.execute(playerId));
  };

  readonly leave = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdParamSchema.parse(request.params);
    await this.leaveQueue.execute(playerId);
    response.status(204).end();
  };
}
