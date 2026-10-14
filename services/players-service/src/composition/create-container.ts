import type { MongoConnection } from "../infrastructure/mongodb/mongo-connection.js";
import { MongoCatalogRepository } from "../infrastructure/mongodb/mongo-catalog-repository.js";
import { MongoPlayerRepository } from "../infrastructure/mongodb/mongo-player-repository.js";
import type { PlayerDocument } from "../infrastructure/mongodb/player-document.js";
import {
  ScryptPasswordHasher,
  SystemClock,
  UuidGenerator,
} from "../infrastructure/system/node-system.js";
import { GetPlayer } from "../application/use-cases/get-player.js";
import { ListPlayers } from "../application/use-cases/list-players.js";
import { RegisterPlayer } from "../application/use-cases/register-player.js";
import { UpdatePlayerProfile } from "../application/use-cases/update-player-profile.js";
import { UpdatePlayerStatus } from "../application/use-cases/update-player-status.js";
import { PlayerController } from "../presentation/http/controllers/player-controller.js";

export function createContainer(connection: MongoConnection) {
  const players = new MongoPlayerRepository(
    connection.database.collection<PlayerDocument>("players"),
  );
  const catalogs = new MongoCatalogRepository(
    connection.database.collection("regions"),
    connection.database.collection("game_modes"),
  );
  const clock = new SystemClock();

  return {
    playerController: new PlayerController(
      new RegisterPlayer(
        players,
        catalogs,
        new ScryptPasswordHasher(),
        clock,
        new UuidGenerator(),
      ),
      new GetPlayer(players),
      new ListPlayers(players),
      new UpdatePlayerProfile(players, catalogs, clock),
      new UpdatePlayerStatus(players, clock),
    ),
  };
}
