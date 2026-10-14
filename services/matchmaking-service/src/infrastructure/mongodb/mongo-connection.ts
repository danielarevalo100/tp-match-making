import { MongoClient, type Db } from "mongodb";

export type MongoConnection = {
  client: MongoClient;
  database: Db;
};

type RetryOptions = {
  attempts: number;
  delayMs: number;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function connectToMongo(
  uri: string,
  databaseName: string,
  retry: RetryOptions,
): Promise<MongoConnection> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    const client = new MongoClient(uri, { appName: "matchmaking-service" });
    try {
      await client.connect();
      const database = client.db(databaseName);
      await database.command({ ping: 1 });
      return { client, database };
    } catch (error: unknown) {
      lastError = error;
      await client.close().catch(() => undefined);
      if (attempt < retry.attempts) await delay(retry.delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("MongoDB connection failed for an unspecified reason.");
}
