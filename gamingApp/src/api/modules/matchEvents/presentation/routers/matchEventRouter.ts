import { Router } from "express";

import type { MatchEventController } from "../controllers/matchEventController.js";

export function createMatchEventRouter(controller: MatchEventController): Router {
  const router = Router();

  router.post("/:matchId/events", controller.record);
  router.get("/:matchId/events", controller.list);
  router.get("/:matchId/scoreboard", controller.scoreboard);
  router.post("/:matchId/scoreboard/reconcile", controller.reconcile);

  return router;
}
