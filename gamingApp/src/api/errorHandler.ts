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

  // Errores de negocio (ver el archivo *Errors.ts de cada módulo).
  if (error instanceof AppError) {
    response
      .status(error.status)
      .json({ error: error.code, message: error.message, ...error.details });
    return;
  }

  if (error instanceof InjectedFailureError) {
    response.status(500).json({ error: "INJECTED_FAILURE", engine: error.engine });
    return;
  }

  if (error instanceof StorageError) {
    console.error(error, error.cause);
    response.status(503).json({ error: "STORAGE_ERROR", engine: error.engine });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
