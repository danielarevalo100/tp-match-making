import { z } from "zod";

const environmentSchema = z
  .object({
    CASSANDRA_CONNECT_RETRIES: z.coerce.number().int().min(1).max(100).default(10),
    CASSANDRA_CONTACT_POINTS: z.string().trim().min(1),
    CASSANDRA_KEYSPACE: z.string().trim().min(1).default("gaming"),
    CASSANDRA_LOCAL_DATACENTER: z.string().trim().min(1).default("datacenter1"),
    CASSANDRA_PORT: z.coerce.number().int().min(1).max(65_535).default(9_042),
    CASSANDRA_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),
    MONGODB_CONNECT_RETRIES: z.coerce.number().int().min(1).max(100).default(10),
    MONGODB_DB_NAME: z.string().trim().min(1).default("gaming"),
    MONGODB_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    MONGODB_URI: z.string().trim().min(1),
    NEO4J_CONNECT_RETRIES: z.coerce.number().int().min(1).max(100).default(10),
    NEO4J_DATABASE: z.string().trim().min(1).default("neo4j"),
    NEO4J_PASSWORD: z.string().min(1),
    NEO4J_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    NEO4J_URI: z.string().trim().min(1),
    NEO4J_USERNAME: z.string().trim().min(1).default("neo4j"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    REDIS_CONNECT_RETRIES: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    REDIS_URL: z.string().trim().min(1),
    SERVICE_NAME: z.string().trim().min(1).default("gaming-app"),
  })
  .passthrough();

export type AppConfig = {
  cassandraConnectRetries: number;
  cassandraContactPoints: string[];
  cassandraKeyspace: string;
  cassandraLocalDataCenter: string;
  cassandraPort: number;
  cassandraRetryDelayMs: number;
  mongoConnectRetries: number;
  mongoDatabaseName: string;
  mongoRetryDelayMs: number;
  mongoUri: string;
  neo4jConnectRetries: number;
  neo4jDatabase: string;
  neo4jPassword: string;
  neo4jRetryDelayMs: number;
  neo4jUri: string;
  neo4jUsername: string;
  nodeEnv: "development" | "test" | "production";
  port: number;
  redisConnectRetries: number;
  redisRetryDelayMs: number;
  redisUrl: string;
  serviceName: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    cassandraConnectRetries: parsed.CASSANDRA_CONNECT_RETRIES,
    cassandraContactPoints: parsed.CASSANDRA_CONTACT_POINTS.split(",")
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
    cassandraKeyspace: parsed.CASSANDRA_KEYSPACE,
    cassandraLocalDataCenter: parsed.CASSANDRA_LOCAL_DATACENTER,
    cassandraPort: parsed.CASSANDRA_PORT,
    cassandraRetryDelayMs: parsed.CASSANDRA_RETRY_DELAY_MS,
    mongoConnectRetries: parsed.MONGODB_CONNECT_RETRIES,
    mongoDatabaseName: parsed.MONGODB_DB_NAME,
    mongoRetryDelayMs: parsed.MONGODB_RETRY_DELAY_MS,
    mongoUri: parsed.MONGODB_URI,
    neo4jConnectRetries: parsed.NEO4J_CONNECT_RETRIES,
    neo4jDatabase: parsed.NEO4J_DATABASE,
    neo4jPassword: parsed.NEO4J_PASSWORD,
    neo4jRetryDelayMs: parsed.NEO4J_RETRY_DELAY_MS,
    neo4jUri: parsed.NEO4J_URI,
    neo4jUsername: parsed.NEO4J_USERNAME,
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    redisConnectRetries: parsed.REDIS_CONNECT_RETRIES,
    redisRetryDelayMs: parsed.REDIS_RETRY_DELAY_MS,
    redisUrl: parsed.REDIS_URL,
    serviceName: parsed.SERVICE_NAME,
  };
}
