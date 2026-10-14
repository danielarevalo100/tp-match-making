import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import {
  PlayerConflictError,
  PlayerNotFoundError,
  RegionNotFoundError,
} from "../../domain/errors/player-errors.js";

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "VALIDATION_ERROR",
      issues: error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.join("."),
      })),
    });
    return;
  }

  if (error instanceof PlayerNotFoundError) {
    response.status(404).json({ error: "PLAYER_NOT_FOUND", message: error.message });
    return;
  }

  if (error instanceof PlayerConflictError) {
    response.status(409).json({
      error: "PLAYER_CONFLICT",
      field: error.field,
      message: error.message,
    });
    return;
  }

  if (error instanceof RegionNotFoundError) {
    response.status(422).json({ error: "REGION_NOT_FOUND", message: error.message });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
