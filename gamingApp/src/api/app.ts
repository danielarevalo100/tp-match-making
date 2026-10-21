import express, { type Express, type Router } from "express";

import { errorHandler } from "./errorHandler.js";
import { faultInjectionMiddleware } from "./middlewares/faultInjectionMiddleware.js";

export type ModuleRoute = {
  path: string;
  router: Router;
};

type AppDependencies = {
  checkReadiness: () => Promise<boolean>;
  routes: readonly ModuleRoute[];
  serviceName: string;
};

export function createApp(dependencies: AppDependencies): Express {
  const app = express();

  app.use(express.json());
  app.use(faultInjectionMiddleware);

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

  for (const route of dependencies.routes) {
    app.use(route.path, route.router);
  }

  app.use((_request, response) => {
    response.status(404).json({ error: "ROUTE_NOT_FOUND" });
  });

  app.use(errorHandler);
  return app;
}
