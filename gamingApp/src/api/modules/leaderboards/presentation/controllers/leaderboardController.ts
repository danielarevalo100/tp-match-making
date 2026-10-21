import type { Request, Response } from "express";

import type { LeaderboardService } from "../../business/services/leaderboardService.js";
import {
  leaderboardParamsSchema,
  leaderboardQuerySchema,
  playerPositionParamsSchema,
} from "../schemas/leaderboardSchema.js";

export class LeaderboardController {
  constructor(private readonly leaderboards: LeaderboardService) {}

  readonly top = async (request: Request, response: Response): Promise<void> => {
    const { mode, seasonId } = leaderboardParamsSchema.parse(request.params);
    const { region } = leaderboardQuerySchema.parse(request.query);
    response.json(await this.leaderboards.top({ mode, region: region ?? null, seasonId }));
  };

  readonly position = async (request: Request, response: Response): Promise<void> => {
    const { mode, playerId, seasonId } = playerPositionParamsSchema.parse(request.params);
    const { region } = leaderboardQuerySchema.parse(request.query);
    response.json(
      await this.leaderboards.position({ mode, region: region ?? null, seasonId }, playerId),
    );
  };

  readonly rebuild = async (request: Request, response: Response): Promise<void> => {
    const { mode, seasonId } = leaderboardParamsSchema.parse(request.params);
    response.json(await this.leaderboards.rebuild(seasonId, mode));
  };
}
