import { randomUUID } from "node:crypto";

import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

import type { PlayerController } from "./presentation/http/controllers/player-controller.js";
import { errorHandler } from "./presentation/http/error-handler.js";
import { createPlayerRouter } from "./presentation/http/routes/player-routes.js";

type AppDependencies = {
  checkReadiness: () => Promise<boolean>;
  playerController: PlayerController;
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

  app.use("/players", createPlayerRouter(dependencies.playerController));

  app.use((_request, response) => {
    response.status(404).json({ error: "ROUTE_NOT_FOUND" });
  });

  app.use(errorHandler);
  return app;
}
