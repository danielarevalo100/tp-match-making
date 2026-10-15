import type { Redis } from "ioredis";

import type { ModuleRoute } from "../api/app.js";
import type { MongoConnection } from "../infrastructure/mongo/mongoConnection.js";
import { createMatchmakingComposition } from "./matchmakingComposition.js";
import { createPlayersComposition } from "./playersComposition.js";

type ContainerConnections = {
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
    ],
  };
}
