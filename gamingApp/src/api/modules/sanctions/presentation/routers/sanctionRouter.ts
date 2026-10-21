import { Router } from "express";

import type { SanctionController } from "../controllers/sanctionController.js";

export function createSanctionRouter(controller: SanctionController): Router {
  const router = Router();
  router.post("/", controller.create);
  router.get("/:sanctionId", controller.get);
  router.post("/:sanctionId/resume", controller.resume);
  return router;
}
