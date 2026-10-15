import type { ModuleRoute } from "../api/app.js";
import type { MongoConnection } from "../infrastructure/mongo/mongoConnection.js";
import { createPlayersComposition } from "./playersComposition.js";

type ContainerConnections = {
  mongo: MongoConnection;
};

export function createContainer(connections: ContainerConnections): {
  routes: readonly ModuleRoute[];
} {
  return {
    routes: [createPlayersComposition(connections.mongo.database)],
  };
}
