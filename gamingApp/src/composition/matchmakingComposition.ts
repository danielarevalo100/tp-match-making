import type { Redis } from "ioredis";
import type { Db } from "mongodb";

import type { ModuleRoute } from "../api/app.js";
import { MatchmakingService } from "../api/modules/matchmaking/business/services/matchmakingService.js";
import { MongoEligibilityAdapter } from "../api/modules/matchmaking/infrastructure/adapters/mongoEligibilityAdapter.js";
import { RedisQueueAdapter } from "../api/modules/matchmaking/infrastructure/adapters/redisQueueAdapter.js";
import { MatchmakingController } from "../api/modules/matchmaking/presentation/controllers/matchmakingController.js";
import { createMatchmakingRouter } from "../api/modules/matchmaking/presentation/routers/matchmakingRouter.js";

export function createMatchmakingComposition(database: Db, redis: Redis): ModuleRoute {
  const matchmakingService = new MatchmakingService(
    new MongoEligibilityAdapter(database),
    new RedisQueueAdapter(redis),
  );

  return {
    path: "/matchmaking",
    router: createMatchmakingRouter(new MatchmakingController(matchmakingService)),
  };
}
