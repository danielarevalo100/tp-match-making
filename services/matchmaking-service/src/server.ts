import { createApp } from "./app.js";
import { createContainer } from "./composition/create-container.js";
import { loadConfig } from "./config.js";
import { connectToMongo } from "./infrastructure/mongodb/mongo-connection.js";
import { connectToRedis } from "./infrastructure/redis/redis-connection.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const mongo = await connectToMongo(config.mongoUri, config.mongoDatabaseName, {
    attempts: config.mongoConnectRetries,
    delayMs: config.mongoRetryDelayMs,
  });
  const redis = await connectToRedis(config.redisUrl, {
    attempts: config.redisConnectRetries,
    delayMs: config.redisRetryDelayMs,
  });
  // Without a listener, a dropped connection would crash the process; ioredis
  // reconnects on its own and commands fail fast in the meantime.
  redis.on("error", (error: Error) => console.error("Redis error", error.message));

  const container = createContainer(mongo, redis);
  const app = createApp({
    checkReadiness: async () => {
      await mongo.database.command({ ping: 1 });
      return (await redis.ping()) === "PONG";
    },
    queueController: container.queueController,
    serviceName: config.serviceName,
  });

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`${config.serviceName} listening on port ${config.port}`);
  });

  let isShuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} received; shutting down ${config.serviceName}`);

    const forceExitTimer = setTimeout(() => {
      console.error("Graceful shutdown timed out");
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    server.close((serverError) => {
      void Promise.all([mongo.client.close(), redis.quit()])
        .then(() => {
          clearTimeout(forceExitTimer);
          if (serverError) {
            console.error("Failed to close HTTP server", serverError);
            process.exit(1);
          }
          process.exit(0);
        })
        .catch((closeError: unknown) => {
          console.error("Failed to close database connections", closeError);
          process.exit(1);
        });
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  console.error("Matchmaking service failed to start", error);
  process.exit(1);
});
