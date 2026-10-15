import type { Request, Response } from "express";

import type { MatchmakingService } from "../../business/services/matchmakingService.js";
import { enqueueSchema, playerIdParamSchema } from "../schemas/matchmakingSchema.js";

export class MatchmakingController {
  constructor(private readonly matchmakingService: MatchmakingService) {}

  readonly enqueue = async (request: Request, response: Response): Promise<void> => {
    const input = enqueueSchema.parse(request.body as unknown);
    const { created, ticket } = await this.matchmakingService.enqueue(input);
    response.status(created ? 201 : 200).json(ticket);
  };

  readonly getTicket = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdParamSchema.parse(request.params);
    response.json(await this.matchmakingService.getTicket(playerId));
  };

  readonly leave = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdParamSchema.parse(request.params);
    await this.matchmakingService.leave(playerId);
    response.status(204).end();
  };
}
