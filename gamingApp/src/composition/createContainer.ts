import type { Client } from "cassandra-driver";
import type { Redis } from "ioredis";

import type { ModuleRoute } from "../api/app.js";
import type { MongoConnection } from "../infrastructure/mongo/mongoConnection.js";
import { createLeaderboardsComposition } from "./leaderboardsComposition.js";
import { createMatchClosureComposition } from "./matchClosureComposition.js";
import { createMatchEventsComposition } from "./matchEventsComposition.js";
import { createMatchmakingComposition } from "./matchmakingComposition.js";
import { createPlayersComposition } from "./playersComposition.js";

type ContainerConnections = {
  cassandra: Client;
  mongo: MongoConnection;
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
      createLeaderboardsComposition(connections.mongo.database, connections.redis),
    ],
  };
}
