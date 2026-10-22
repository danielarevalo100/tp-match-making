import type { Client } from "cassandra-driver";
import type { Redis } from "ioredis";
import type { Db } from "mongodb";

import type { ModuleRoute } from "../api/app.js";
import { RedisLeaderboardAdapter } from "../api/modules/leaderboards/infrastructure/adapters/redisLeaderboardAdapter.js";
import { RedisQueueAdapter } from "../api/modules/matchmaking/infrastructure/adapters/redisQueueAdapter.js";
import { CassandraPlayerHistoryAdapter } from "../api/modules/playerHistory/infrastructure/adapters/cassandraPlayerHistoryAdapter.js";
import { PlayerProfileService } from "../api/modules/sanctions/business/services/playerProfileService.js";
import { SanctionService } from "../api/modules/sanctions/business/services/sanctionService.js";
import { CassandraHistoryCleanupAdapter } from "../api/modules/sanctions/infrastructure/adapters/cassandraHistoryCleanupAdapter.js";
import { MongoPlayerProfileAdapter } from "../api/modules/sanctions/infrastructure/adapters/mongoPlayerProfileAdapter.js";
import { MongoResultReversalAdapter } from "../api/modules/sanctions/infrastructure/adapters/mongoResultReversalAdapter.js";
import { MongoSanctionAdapter } from "../api/modules/sanctions/infrastructure/adapters/mongoSanctionAdapter.js";
import { Neo4jGraphCleanupAdapter } from "../api/modules/sanctions/infrastructure/adapters/neo4jGraphCleanupAdapter.js";
import { PlayerProfileController } from "../api/modules/sanctions/presentation/controllers/playerProfileController.js";
import { SanctionController } from "../api/modules/sanctions/presentation/controllers/sanctionController.js";
import { createPlayerProfileRouter } from "../api/modules/sanctions/presentation/routers/playerProfileRouter.js";
import { createSanctionRouter } from "../api/modules/sanctions/presentation/routers/sanctionRouter.js";
import type { Neo4jConnection } from "../infrastructure/neo4j/neo4jConnection.js";

type SanctionsConnections = {
  cassandra: Client;
  mongo: Db;
  neo4j: Neo4jConnection;
  redis: Redis;
};

/** Problema 8: la sanción con su reversión, y el perfil del jugador que recorre todas las bases. */
export function createSanctionsComposition(connections: SanctionsConnections): ModuleRoute[] {
  const leaderboard = new RedisLeaderboardAdapter(connections.redis);
  const sanctions = new SanctionService(
    new MongoSanctionAdapter(connections.mongo),
    new MongoResultReversalAdapter(connections.mongo),
    new RedisQueueAdapter(connections.redis),
    new CassandraHistoryCleanupAdapter(connections.cassandra),
    new Neo4jGraphCleanupAdapter(connections.neo4j),
    leaderboard,
  );
  const profiles = new PlayerProfileService(
    new MongoPlayerProfileAdapter(connections.mongo),
    leaderboard,
    new CassandraPlayerHistoryAdapter(connections.cassandra),
  );
  return [
    { path: "/sanctions", router: createSanctionRouter(new SanctionController(sanctions)) },
    {
      path: "/profiles",
      router: createPlayerProfileRouter(new PlayerProfileController(profiles)),
    },
  ];
}
