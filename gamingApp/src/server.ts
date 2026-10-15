import { createApp } from "./api/app.js";
import { createContainer } from "./composition/createContainer.js";
import { loadConfig } from "./config.js";
import { connectToMongo } from "./infrastructure/mongo/mongoConnection.js";
import { connectToRedis } from "./infrastructure/redis/redisConnection.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const mongo = await connectToMongo({
    appName: config.serviceName,
    attempts: config.mongoConnectRetries,
    databaseName: config.mongoDatabaseName,
    delayMs: config.mongoRetryDelayMs,
    uri: config.mongoUri,
  });
  const redis = await connectToRedis({
    attempts: config.redisConnectRetries,
    delayMs: config.redisRetryDelayMs,
    url: config.redisUrl,
  });
  redis.on("error", (error: Error) => console.error("Redis error", error.message));

  const container = createContainer({ mongo, redis });
  const app = createApp({
    checkReadiness: async () => {
      await mongo.database.command({ ping: 1 });
      return (await redis.ping()) === "PONG";
    },
    routes: container.routes,
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
  console.error("Gaming app failed to start", error);
  process.exit(1);
});
