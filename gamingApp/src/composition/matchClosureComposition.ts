import type { Client } from "cassandra-driver";
import type { Redis } from "ioredis";
import type { Db } from "mongodb";

import type { ModuleRoute } from "../api/app.js";
import { RedisLeaderboardAdapter } from "../api/modules/leaderboards/infrastructure/adapters/redisLeaderboardAdapter.js";
import { MatchClosureService } from "../api/modules/matchClosure/business/services/matchClosureService.js";
import { CassandraMatchClosureAdapter } from "../api/modules/matchClosure/infrastructure/adapters/cassandraMatchClosureAdapter.js";
import { MongoMatchClosureAdapter } from "../api/modules/matchClosure/infrastructure/adapters/mongoMatchClosureAdapter.js";
import { RedisMatchClosureAdapter } from "../api/modules/matchClosure/infrastructure/adapters/redisMatchClosureAdapter.js";
import { MatchClosureController } from "../api/modules/matchClosure/presentation/controllers/matchClosureController.js";
import { createMatchClosureRouter } from "../api/modules/matchClosure/presentation/routers/matchClosureRouter.js";

export function createMatchClosureComposition(
  database: Db,
  redis: Redis,
  cassandra: Client,
): ModuleRoute {
  const service = new MatchClosureService(
    new MongoMatchClosureAdapter(database),
    new RedisMatchClosureAdapter(redis),
    new CassandraMatchClosureAdapter(cassandra),
    new RedisLeaderboardAdapter(redis),
  );
  return {
    path: "/matches",
    router: createMatchClosureRouter(new MatchClosureController(service)),
  };
}
