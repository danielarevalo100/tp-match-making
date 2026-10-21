import type { Request, Response } from "express";

import type { MatchEventService } from "../../business/services/matchEventService.js";
import {
  listEventsSchema,
  matchIdParamSchema,
  recordEventSchema,
} from "../schemas/matchEventSchema.js";

export class MatchEventController {
  constructor(private readonly events: MatchEventService) {}

  readonly record = async (request: Request, response: Response): Promise<void> => {
    const { matchId } = matchIdParamSchema.parse(request.params);
    const body = recordEventSchema.parse(request.body as unknown);
    const result = await this.events.record({ matchId, ...body });
    response.status(result.status === "recorded" ? 201 : 200).json(result);
  };

  readonly list = async (request: Request, response: Response): Promise<void> => {
    const { matchId } = matchIdParamSchema.parse(request.params);
    const query = listEventsSchema.parse(request.query);
    response.json(await this.events.listEvents(matchId, query));
  };

  readonly scoreboard = async (request: Request, response: Response): Promise<void> => {
    const { matchId } = matchIdParamSchema.parse(request.params);
    response.json(await this.events.getScoreboard(matchId));
  };

  readonly reconcile = async (request: Request, response: Response): Promise<void> => {
    const { matchId } = matchIdParamSchema.parse(request.params);
    response.json(await this.events.reconcile(matchId));
  };
}
