import { createApp } from "./api/app.js";
import { createContainer } from "./composition/createContainer.js";
import { loadConfig } from "./config.js";
import { connectToCassandra } from "./infrastructure/cassandra/cassandraConnection.js";
import { connectToMongo } from "./infrastructure/mongo/mongoConnection.js";
import { connectToNeo4j } from "./infrastructure/neo4j/neo4jConnection.js";
import { connectToRedis } from "./infrastructure/redis/redisConnection.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const mongo = await connectToMongo({
    appName: config.SERVICE_NAME,
    attempts: config.MONGODB_CONNECT_RETRIES,
    databaseName: config.MONGODB_DB_NAME,
    delayMs: config.MONGODB_RETRY_DELAY_MS,
    uri: config.MONGODB_URI,
  });
  const redis = await connectToRedis({
    attempts: config.REDIS_CONNECT_RETRIES,
    delayMs: config.REDIS_RETRY_DELAY_MS,
    url: config.REDIS_URL,
  });
  redis.on("error", (error: Error) => console.error("Redis error", error.message));
  const cassandra = await connectToCassandra({
    attempts: config.CASSANDRA_CONNECT_RETRIES,
    contactPoints: config.CASSANDRA_CONTACT_POINTS,
    delayMs: config.CASSANDRA_RETRY_DELAY_MS,
    keyspace: config.CASSANDRA_KEYSPACE,
    localDataCenter: config.CASSANDRA_LOCAL_DATACENTER,
    port: config.CASSANDRA_PORT,
  });
  const neo4j = await connectToNeo4j({
    attempts: config.NEO4J_CONNECT_RETRIES,
    database: config.NEO4J_DATABASE,
    delayMs: config.NEO4J_RETRY_DELAY_MS,
    password: config.NEO4J_PASSWORD,
    uri: config.NEO4J_URI,
    username: config.NEO4J_USERNAME,
  });

  const container = createContainer({ cassandra, mongo, neo4j, redis });
  const app = createApp({
    checkReadiness: async () => {
      await mongo.database.command({ ping: 1 });
      await cassandra.execute("SELECT release_version FROM system.local");
      await neo4j.driver.verifyConnectivity({ database: neo4j.database });
      return (await redis.ping()) === "PONG";
    },
    routes: container.routes,
    serviceName: config.SERVICE_NAME,
  });

  const server = app.listen(config.PORT, "0.0.0.0", () => {
    console.log(`${config.SERVICE_NAME} listening on port ${config.PORT}`);
  });

  // Deja de aceptar pedidos y cierra las conexiones a las bases (docker compose stop / Ctrl+C).
  const shutdown = async (): Promise<void> => {
    console.log(`Shutting down ${config.SERVICE_NAME}`);
    server.close();
    await Promise.allSettled([
      mongo.client.close(),
      redis.quit(),
      cassandra.shutdown(),
      neo4j.driver.close(),
    ]);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error("Gaming app failed to start", error);
  process.exit(1);
});
