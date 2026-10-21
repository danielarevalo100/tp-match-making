import type { Request, Response } from "express";

import type { MatchClosureService } from "../../business/services/matchClosureService.js";
import { finishMatchParamsSchema, finishMatchSchema } from "../schemas/matchClosureSchema.js";

export class MatchClosureController {
  constructor(private readonly closure: MatchClosureService) {}

  readonly finish = async (request: Request, response: Response): Promise<void> => {
    const { matchId } = finishMatchParamsSchema.parse(request.params);
    const body = finishMatchSchema.parse(request.body as unknown);
    const result = await this.closure.finish({ matchId, ...body });
    const complete = result.scoringStatus === "applied" && result.leaderboardStatus !== "pending";
    response.status(complete ? 200 : 202).json(result);
  };
}
