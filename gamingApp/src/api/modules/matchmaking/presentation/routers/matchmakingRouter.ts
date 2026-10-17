import { Router } from "express";

import type { MatchFormationController } from "../controllers/matchFormationController.js";
import type { MatchmakingController } from "../controllers/matchmakingController.js";

export function createMatchmakingRouter(
  controller: MatchmakingController,
  formationController?: MatchFormationController,
): Router {
  const router = Router();

  router.post("/queue", controller.enqueue);
  router.get("/queue/:playerId", controller.getTicket);
  router.delete("/queue/:playerId", controller.leave);
  router.post("/queue/:playerId/sanction-check", controller.evictIfSanctioned);

  if (formationController) {
    router.post("/matches/form", formationController.form);
    router.post("/matches/recover", formationController.recover);
  }

  return router;
}
