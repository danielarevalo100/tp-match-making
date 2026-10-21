import type { Db } from "mongodb";

import type { ModuleRoute } from "../api/app.js";
import { PlayersService } from "../api/modules/players/business/services/playersService.js";
import { MongoCatalogAdapter } from "../api/modules/players/infrastructure/adapters/mongoCatalogAdapter.js";
import { MongoPlayersAdapter } from "../api/modules/players/infrastructure/adapters/mongoPlayersAdapter.js";
import { PlayersController } from "../api/modules/players/presentation/controllers/playersController.js";
import { createPlayersRouter } from "../api/modules/players/presentation/routers/playersRouter.js";

export function createPlayersComposition(database: Db): ModuleRoute {
  const playersService = new PlayersService(
    new MongoPlayersAdapter(database),
    new MongoCatalogAdapter(database),
  );

  return {
    path: "/players",
    router: createPlayersRouter(new PlayersController(playersService)),
  };
}
