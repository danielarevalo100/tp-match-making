import { Router } from "express";

import type { PlayerController } from "../controllers/player-controller.js";

export function createPlayerRouter(controller: PlayerController): Router {
  const router = Router();

  router.post("/", controller.register);
  router.get("/", controller.list);
  router.get("/:playerId", controller.getById);
  router.patch("/:playerId", controller.updateProfile);
  router.patch("/:playerId/status", controller.updateStatus);

  return router;
}
