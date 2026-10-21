import { Router } from "express";

import type { MatchClosureController } from "../controllers/matchClosureController.js";

export function createMatchClosureRouter(controller: MatchClosureController): Router {
  const router = Router();
  router.post("/:matchId/finish", controller.finish);
  return router;
}
