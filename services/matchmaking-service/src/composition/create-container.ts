import type { Redis } from "ioredis";

import { EnqueuePlayer } from "../application/use-cases/enqueue-player.js";
import { GetQueueTicket } from "../application/use-cases/get-queue-ticket.js";
import { LeaveQueue } from "../application/use-cases/leave-queue.js";
import type { MongoConnection } from "../infrastructure/mongodb/mongo-connection.js";
import { MongoEligibilityRepository } from "../infrastructure/mongodb/mongo-eligibility-repository.js";
import { RedisMatchmakingQueue } from "../infrastructure/redis/redis-matchmaking-queue.js";
import { SystemClock, UuidGenerator } from "../infrastructure/system/node-system.js";
import { QueueController } from "../presentation/http/controllers/queue-controller.js";

export function createContainer(mongo: MongoConnection, redis: Redis) {
  const eligibility = new MongoEligibilityRepository(
    mongo.database.collection("players"),
    mongo.database.collection("game_modes"),
    mongo.database.collection("regions"),
    mongo.database.collection("sanctions"),
  );
  const queue = new RedisMatchmakingQueue(redis);

  return {
    queueController: new QueueController(
      new EnqueuePlayer(eligibility, queue, new SystemClock(), new UuidGenerator()),
      new GetQueueTicket(queue),
      new LeaveQueue(queue),
    ),
  };
}
