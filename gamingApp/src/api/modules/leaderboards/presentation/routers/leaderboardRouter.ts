import { Router } from "express";

import type { LeaderboardController } from "../controllers/leaderboardController.js";

export function createLeaderboardRouter(controller: LeaderboardController): Router {
  const router = Router();
  router.get("/:mode/:seasonId", controller.top);
  router.get("/:mode/:seasonId/players/:playerId", controller.position);
  router.post("/:mode/:seasonId/rebuild", controller.rebuild);
  return router;
}
