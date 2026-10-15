import type { NextFunction, Request, Response } from "express";

import { requestContext } from "../../shared/requestContext.js";

export const failAtHeader = "x-fail-at";

export function faultInjectionMiddleware(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const failAt = request.header(failAtHeader)?.trim();
  requestContext.run(failAt ? { failAt } : {}, next);
}
