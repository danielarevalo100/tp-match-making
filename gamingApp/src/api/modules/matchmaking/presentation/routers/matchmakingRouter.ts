import { Router } from "express";

import type { MatchmakingController } from "../controllers/matchmakingController.js";

export function createMatchmakingRouter(controller: MatchmakingController): Router {
  const router = Router();

  router.post("/queue", controller.enqueue);
  router.get("/queue/:playerId", controller.getTicket);
  router.delete("/queue/:playerId", controller.leave);

  return router;
}
