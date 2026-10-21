import type { Db } from "mongodb";

import type { ModuleRoute } from "../api/app.js";
import { FraudDetectionService } from "../api/modules/fraudDetection/business/services/fraudDetectionService.js";
import { FraudGraphProjectionService } from "../api/modules/fraudDetection/business/services/fraudGraphProjectionService.js";
import { MongoPlayerNamesAdapter } from "../api/modules/fraudDetection/infrastructure/adapters/mongoPlayerNamesAdapter.js";
import { MongoReportsAdapter } from "../api/modules/fraudDetection/infrastructure/adapters/mongoReportsAdapter.js";
import { Neo4jMatchGraphAdapter } from "../api/modules/fraudDetection/infrastructure/adapters/neo4jMatchGraphAdapter.js";
import { FraudController } from "../api/modules/fraudDetection/presentation/controllers/fraudController.js";
import { createFraudRouter } from "../api/modules/fraudDetection/presentation/routers/fraudRouter.js";
import { MongoClosedMatchAdapter } from "../api/modules/playerHistory/infrastructure/adapters/mongoClosedMatchAdapter.js";
import type { Neo4jConnection } from "../infrastructure/neo4j/neo4jConnection.js";

export function createFraudComposition(database: Db, neo4j: Neo4jConnection): ModuleRoute {
  const graph = new Neo4jMatchGraphAdapter(neo4j);
  return {
    path: "/fraud",
    router: createFraudRouter(
      new FraudController(
        new FraudDetectionService(
          graph,
          new MongoReportsAdapter(database),
          new MongoPlayerNamesAdapter(database),
        ),
        new FraudGraphProjectionService(new MongoClosedMatchAdapter(database), graph),
      ),
    ),
  };
}
