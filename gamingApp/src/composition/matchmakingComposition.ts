import type { Redis } from "ioredis";
import type { Db } from "mongodb";

import type { ModuleRoute } from "../api/app.js";
import { MatchFormationService } from "../api/modules/matchmaking/business/services/matchFormationService.js";
import { MatchmakingService } from "../api/modules/matchmaking/business/services/matchmakingService.js";
import { MongoEligibilityAdapter } from "../api/modules/matchmaking/infrastructure/adapters/mongoEligibilityAdapter.js";
import { MongoMatchAdapter } from "../api/modules/matchmaking/infrastructure/adapters/mongoMatchAdapter.js";
import { RedisQueueAdapter } from "../api/modules/matchmaking/infrastructure/adapters/redisQueueAdapter.js";
import { MatchFormationController } from "../api/modules/matchmaking/presentation/controllers/matchFormationController.js";
import { MatchmakingController } from "../api/modules/matchmaking/presentation/controllers/matchmakingController.js";
import { createMatchmakingRouter } from "../api/modules/matchmaking/presentation/routers/matchmakingRouter.js";

export function createMatchmakingComposition(database: Db, redis: Redis): ModuleRoute {
  const eligibility = new MongoEligibilityAdapter(database);
  const queue = new RedisQueueAdapter(redis);
  const matchmakingService = new MatchmakingService(eligibility, queue);
  const formationService = new MatchFormationService(
    eligibility,
    queue,
    new MongoMatchAdapter(database),
  );

  return {
    path: "/matchmaking",
    router: createMatchmakingRouter(
      new MatchmakingController(matchmakingService),
      new MatchFormationController(formationService),
    ),
  };
}
