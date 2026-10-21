import type { Client } from "cassandra-driver";
import type { Redis } from "ioredis";

import type { ModuleRoute } from "../api/app.js";
import type { MongoConnection } from "../infrastructure/mongo/mongoConnection.js";
import type { Neo4jConnection } from "../infrastructure/neo4j/neo4jConnection.js";
import { createFraudComposition } from "./fraudComposition.js";
import { createLeaderboardsComposition } from "./leaderboardsComposition.js";
import { createMatchClosureComposition } from "./matchClosureComposition.js";
import { createMatchEventsComposition } from "./matchEventsComposition.js";
import { createMatchmakingComposition } from "./matchmakingComposition.js";
import { createPlayerHistoryComposition } from "./playerHistoryComposition.js";
import { createPlayersComposition } from "./playersComposition.js";

type ContainerConnections = {
  cassandra: Client;
  mongo: MongoConnection;
  neo4j: Neo4jConnection;
  redis: Redis;
};

export function createContainer(connections: ContainerConnections): {
  routes: readonly ModuleRoute[];
} {
  return {
    routes: [
      createPlayersComposition(connections.mongo.database),
      createMatchmakingComposition(connections.mongo.database, connections.redis),
      createMatchEventsComposition(connections.cassandra, connections.redis),
      createMatchClosureComposition(
        connections.mongo.database,
        connections.redis,
        connections.cassandra,
      ),
      createPlayerHistoryComposition(connections.mongo.database, connections.cassandra),
      createFraudComposition(connections.mongo.database, connections.neo4j),
      createLeaderboardsComposition(connections.mongo.database, connections.redis),
    ],
  };
}
