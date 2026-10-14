import { Router } from "express";

import type { QueueController } from "../controllers/queue-controller.js";

export function createQueueRouter(controller: QueueController): Router {
  const router = Router();

  router.post("/", controller.enqueue);
  router.get("/:playerId", controller.getTicket);
  router.delete("/:playerId", controller.leave);

  return router;
}
