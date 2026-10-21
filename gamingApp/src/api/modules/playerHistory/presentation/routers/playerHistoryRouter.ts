import { Router } from "express";

import type { PlayerHistoryController } from "../controllers/playerHistoryController.js";

export function createPlayerHistoryRouter(controller: PlayerHistoryController): Router {
  const router = Router();

  router.get("/players/:playerId", controller.get);
  router.post("/projection", controller.project);

  return router;
}
