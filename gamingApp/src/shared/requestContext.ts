import { AsyncLocalStorage } from "node:async_hooks";

import { InjectedFailureError, type StorageEngine } from "./errors.js";

/** Datos de simulación que viajan con cada request (los arma el middleware de fallas). */
export type RequestContext = {
  /** Base cuya próxima escritura debe fallar (header `x-fail-db`). */
  failDb?: StorageEngine;
  /** Pausa después de reservar jugadores al formar una partida (header `x-pause-after-reserve-ms`). */
  pauseAfterReserveMs?: number;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Simulación de fallas: si el request pidió que falle `engine`, la primera escritura en esa base
 * lanza `InjectedFailureError` antes de tocarla. Solo falla una vez, así las compensaciones que
 * escriben en la misma base pueden ejecutarse.
 */
export function failIfRequested(engine: StorageEngine): void {
  const context = requestContext.getStore();
  if (context?.failDb !== engine) return;
  delete context.failDb;
  throw new InjectedFailureError(engine);
}
