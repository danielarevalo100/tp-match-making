import { randomUUID } from "node:crypto";

import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";

import type { AppConfig } from "./config.js";

export function createApp(config: AppConfig) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = request.header("x-request-id") ?? randomUUID();
    response.setHeader("x-request-id", requestId);
    next();
  });

  app.get("/", (_request, response) => {
    response.json({
      service: config.serviceName,
      message: "Service is running",
    });
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: config.serviceName });
  });

  app.get("/ready", (_request, response) => {
    // Add dependency checks here when the service gains a database or broker.
    response.json({ status: "ready", service: config.serviceName });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Route not found" });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  return app;
}
