import type { NextFunction, Request, Response } from "express";

import { storageEngines, type StorageEngine } from "../../shared/errors.js";
import { requestContext, type RequestContext } from "../../shared/requestContext.js";

/** `x-fail-db: mongo | redis | cassandra | neo4j`: falla la primera escritura en esa base. */
export const failDbHeader = "x-fail-db";
// Frena la formación de una partida entre la reserva de jugadores y el commit, para que una demo
// pueda hacer que un jugador se vaya "durante la formación".
export const pauseAfterReserveHeader = "x-pause-after-reserve-ms";

const maxPauseMs = 30_000;

export function faultInjectionMiddleware(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const context: RequestContext = {};

  const failDb = request.header(failDbHeader)?.trim().toLowerCase();
  if (storageEngines.includes(failDb as StorageEngine)) context.failDb = failDb as StorageEngine;

  const pause = Number(request.header(pauseAfterReserveHeader));
  if (pause > 0) context.pauseAfterReserveMs = Math.min(pause, maxPauseMs);

  requestContext.run(context, next);
}
