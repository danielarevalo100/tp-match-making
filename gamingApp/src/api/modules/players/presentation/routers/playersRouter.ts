import { Router } from "express";

import type { PlayersController } from "../controllers/playersController.js";

export function createPlayersRouter(controller: PlayersController): Router {
  const router = Router();

  router.post("/", controller.register);
  router.get("/", controller.list);
  router.get("/:playerId", controller.getById);
  router.patch("/:playerId", controller.updateProfile);
  router.patch("/:playerId/status", controller.updateStatus);

  return router;
}
