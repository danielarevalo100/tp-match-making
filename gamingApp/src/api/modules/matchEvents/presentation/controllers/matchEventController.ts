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
    const result = await this.events.record({
      eventId: body.eventId,
      matchId,
      playerId: body.playerId,
      tsMs: body.tsMs,
      type: body.type,
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
      ...(body.points !== undefined ? { points: body.points } : {}),
      ...(body.targetPlayerId !== undefined ? { targetPlayerId: body.targetPlayerId } : {}),
    });
    response.status(result.status === "recorded" ? 201 : 200).json(result);
  };

  readonly list = async (request: Request, response: Response): Promise<void> => {
    const { matchId } = matchIdParamSchema.parse(request.params);
    const { fromTsMs, limit, pageState, toTsMs } = listEventsSchema.parse(request.query);
    const page = await this.events.listEvents(matchId, {
      limit,
      ...(fromTsMs !== undefined ? { fromTsMs } : {}),
      ...(pageState !== undefined ? { pageState } : {}),
      ...(toTsMs !== undefined ? { toTsMs } : {}),
    });
    response.json(page);
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
