import type { Redis } from "ioredis";
import type { Db } from "mongodb";

import type { ModuleRoute } from "../api/app.js";
import { LeaderboardService } from "../api/modules/leaderboards/business/services/leaderboardService.js";
import { MongoLeaderboardAdapter } from "../api/modules/leaderboards/infrastructure/adapters/mongoLeaderboardAdapter.js";
import { RedisLeaderboardAdapter } from "../api/modules/leaderboards/infrastructure/adapters/redisLeaderboardAdapter.js";
import { LeaderboardController } from "../api/modules/leaderboards/presentation/controllers/leaderboardController.js";
import { createLeaderboardRouter } from "../api/modules/leaderboards/presentation/routers/leaderboardRouter.js";

export function createLeaderboardsComposition(database: Db, redis: Redis): ModuleRoute {
  const service = new LeaderboardService(
    new RedisLeaderboardAdapter(redis),
    new MongoLeaderboardAdapter(database),
  );
  return {
    path: "/leaderboards",
    router: createLeaderboardRouter(new LeaderboardController(service)),
  };
}
