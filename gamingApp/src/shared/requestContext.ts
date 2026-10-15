import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  failAt?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();
