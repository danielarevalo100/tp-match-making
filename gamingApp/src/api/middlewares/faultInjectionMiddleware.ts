import type { NextFunction, Request, Response } from "express";

import { requestContext, type RequestContext } from "../../shared/requestContext.js";

export const failAtHeader = "x-fail-at";
// Holds a match formation between reserving the players and committing it, so a
// demo can make a player leave "during the formation".
export const pauseAfterReserveHeader = "x-pause-after-reserve-ms";

const maxPauseMs = 30_000;

export function faultInjectionMiddleware(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const context: RequestContext = {};
  const failAt = request.header(failAtHeader)?.trim();
  if (failAt) context.failAt = failAt;

  const pause = Number(request.header(pauseAfterReserveHeader));
  if (Number.isFinite(pause) && pause > 0)
    context.pauseAfterReserveMs = Math.min(pause, maxPauseMs);

  requestContext.run(context, next);
}
