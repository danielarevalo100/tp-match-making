import { Router } from "express";

import type { PlayerProfileController } from "../controllers/playerProfileController.js";

export function createPlayerProfileRouter(controller: PlayerProfileController): Router {
  const router = Router();
  router.get("/:playerId", controller.get);
  return router;
}
