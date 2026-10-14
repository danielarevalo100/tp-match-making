import { randomUUID } from "node:crypto";

import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

import type { QueueController } from "./presentation/http/controllers/queue-controller.js";
import { errorHandler } from "./presentation/http/error-handler.js";
import { createQueueRouter } from "./presentation/http/routes/queue-routes.js";

type AppDependencies = {
  checkReadiness: () => Promise<boolean>;
  queueController: QueueController;
  serviceName: string;
};

export function createApp(dependencies: AppDependencies) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader("x-request-id", request.header("x-request-id") ?? randomUUID());
    next();
  });

  app.get("/", (_request, response) => {
    response.json({ service: dependencies.serviceName, message: "Service is running" });
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: dependencies.serviceName });
  });

  app.get("/ready", async (_request, response) => {
    const ready = await dependencies.checkReadiness().catch(() => false);
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      service: dependencies.serviceName,
    });
  });

  app.use("/matchmaking/queue", createQueueRouter(dependencies.queueController));

  app.use((_request, response) => {
    response.status(404).json({ error: "ROUTE_NOT_FOUND" });
  });

  app.use(errorHandler);
  return app;
}
