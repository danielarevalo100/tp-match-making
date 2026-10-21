import type { Client } from "cassandra-driver";
import type { Redis } from "ioredis";

import type { ModuleRoute } from "../api/app.js";
import { MatchEventService } from "../api/modules/matchEvents/business/services/matchEventService.js";
import { CassandraEventLogAdapter } from "../api/modules/matchEvents/infrastructure/adapters/cassandraEventLogAdapter.js";
import { RedisScoreboardAdapter } from "../api/modules/matchEvents/infrastructure/adapters/redisScoreboardAdapter.js";
import { MatchEventController } from "../api/modules/matchEvents/presentation/controllers/matchEventController.js";
import { createMatchEventRouter } from "../api/modules/matchEvents/presentation/routers/matchEventRouter.js";

export function createMatchEventsComposition(cassandra: Client, redis: Redis): ModuleRoute {
  const service = new MatchEventService(
    new CassandraEventLogAdapter(cassandra),
    new RedisScoreboardAdapter(redis),
  );

  return {
    path: "/matches",
    router: createMatchEventRouter(new MatchEventController(service)),
  };
}
