import { Router } from "express";

import type { FraudController } from "../controllers/fraudController.js";

export function createFraudRouter(controller: FraudController): Router {
  const router = Router();

  router.get("/match-fixing", controller.matchFixing);
  router.get("/cross-reports", controller.crossReports);
  router.get("/irregular-behavior", controller.irregularBehavior);
  router.post("/projection", controller.project);

  return router;
}
