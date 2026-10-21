import type { Client } from "cassandra-driver";
import type { Db } from "mongodb";

import type { ModuleRoute } from "../api/app.js";
import { PlayerHistoryProjectionService } from "../api/modules/playerHistory/business/services/playerHistoryProjectionService.js";
import { PlayerHistoryService } from "../api/modules/playerHistory/business/services/playerHistoryService.js";
import { CassandraPlayerHistoryAdapter } from "../api/modules/playerHistory/infrastructure/adapters/cassandraPlayerHistoryAdapter.js";
import { MongoClosedMatchAdapter } from "../api/modules/playerHistory/infrastructure/adapters/mongoClosedMatchAdapter.js";
import { MongoPlayerDirectoryAdapter } from "../api/modules/playerHistory/infrastructure/adapters/mongoPlayerDirectoryAdapter.js";
import { PlayerHistoryController } from "../api/modules/playerHistory/presentation/controllers/playerHistoryController.js";
import { createPlayerHistoryRouter } from "../api/modules/playerHistory/presentation/routers/playerHistoryRouter.js";

export function createPlayerHistoryComposition(database: Db, cassandra: Client): ModuleRoute {
  const history = new CassandraPlayerHistoryAdapter(cassandra);
  return {
    path: "/history",
    router: createPlayerHistoryRouter(
      new PlayerHistoryController(
        new PlayerHistoryService(new MongoPlayerDirectoryAdapter(database), history),
        new PlayerHistoryProjectionService(new MongoClosedMatchAdapter(database), history),
      ),
    ),
  };
}
