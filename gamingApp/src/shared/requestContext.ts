import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  failAt?: string;
  pauseAfterReserveMs?: number;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();
