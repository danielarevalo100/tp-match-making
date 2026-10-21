import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { AppError, InjectedFailureError, StorageError } from "../shared/errors.js";

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

  // Business errors (see the *Errors.ts file of each module).
  if (error instanceof AppError) {
    response
      .status(error.status)
      .json({ error: error.code, message: error.message, ...error.details });
    return;
  }

  if (error instanceof InjectedFailureError) {
    response.status(500).json({ error: "INJECTED_FAILURE", step: error.step });
    return;
  }

  if (error instanceof StorageError) {
    console.error(error, error.cause);
    response.status(503).json({ error: "STORAGE_ERROR", engine: error.engine, step: error.step });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
