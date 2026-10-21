import { z } from "zod";

const number = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const text = (fallback: string) => z.string().trim().min(1).default(fallback);
const required = z.string().trim().min(1);

// Environment variables of the app (see .env.example). Missing optional ones take the default.
const environmentSchema = z.object({
  SERVICE_NAME: text("gaming-app"),
  PORT: number(3_000),

  MONGODB_URI: required,
  MONGODB_DB_NAME: text("gaming"),
  MONGODB_CONNECT_RETRIES: number(10),
  MONGODB_RETRY_DELAY_MS: number(2_000),

  REDIS_URL: required,
  REDIS_CONNECT_RETRIES: number(10),
  REDIS_RETRY_DELAY_MS: number(2_000),

  /** Comma-separated list of hosts. */
  CASSANDRA_CONTACT_POINTS: required.transform((value) =>
    value
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
  ),
  CASSANDRA_PORT: number(9_042),
  CASSANDRA_KEYSPACE: text("gaming"),
  CASSANDRA_LOCAL_DATACENTER: text("datacenter1"),
  CASSANDRA_CONNECT_RETRIES: number(10),
  CASSANDRA_RETRY_DELAY_MS: number(3_000),

  NEO4J_URI: required,
  NEO4J_DATABASE: text("neo4j"),
  NEO4J_USERNAME: text("neo4j"),
  NEO4J_PASSWORD: z.string().min(1),
  NEO4J_CONNECT_RETRIES: number(10),
  NEO4J_RETRY_DELAY_MS: number(2_000),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return environmentSchema.parse(environment);
}
