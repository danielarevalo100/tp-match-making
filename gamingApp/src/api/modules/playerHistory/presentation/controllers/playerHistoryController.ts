import type { Request, Response } from "express";

import type { PlayerHistoryProjectionService } from "../../business/services/playerHistoryProjectionService.js";
import type { PlayerHistoryService } from "../../business/services/playerHistoryService.js";
import { playerHistoryParamsSchema, projectHistorySchema } from "../schemas/playerHistorySchema.js";

export class PlayerHistoryController {
  constructor(
    private readonly history: PlayerHistoryService,
    private readonly projection: PlayerHistoryProjectionService,
  ) {}

  readonly get = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerHistoryParamsSchema.parse(request.params);
    response.json(await this.history.getHistory(playerId));
  };

  readonly project = async (request: Request, response: Response): Promise<void> => {
    const body = projectHistorySchema.parse(request.body ?? {});
    response.json(
      await this.projection.project({
        afterId: body.afterId ?? null,
        limit: body.limit,
        since: body.since,
      }),
    );
  };
}
