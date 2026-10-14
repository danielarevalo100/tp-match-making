import { z } from "zod";

const environmentSchema = z
  .object({
    MONGODB_CONNECT_RETRIES: z.coerce.number().int().min(1).max(100).default(10),
    MONGODB_DB_NAME: z.string().trim().min(1).default("gaming"),
    MONGODB_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    MONGODB_URI: z.string().trim().min(1),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    SERVICE_NAME: z.string().trim().min(1).default("players-service"),
  })
  .passthrough();

export type AppConfig = {
  mongoConnectRetries: number;
  mongoDatabaseName: string;
  mongoRetryDelayMs: number;
  mongoUri: string;
  nodeEnv: "development" | "test" | "production";
  port: number;
  serviceName: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    mongoConnectRetries: parsed.MONGODB_CONNECT_RETRIES,
    mongoDatabaseName: parsed.MONGODB_DB_NAME,
    mongoRetryDelayMs: parsed.MONGODB_RETRY_DELAY_MS,
    mongoUri: parsed.MONGODB_URI,
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    serviceName: parsed.SERVICE_NAME,
  };
}
