import { MongoClient, type Db } from "mongodb";

export type MongoConnection = {
  client: MongoClient;
  database: Db;
};

type MongoConnectionOptions = {
  appName: string;
  attempts: number;
  databaseName: string;
  delayMs: number;
  uri: string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function connectToMongo(options: MongoConnectionOptions): Promise<MongoConnection> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const client = new MongoClient(options.uri, { appName: options.appName });
    try {
      await client.connect();
      const database = client.db(options.databaseName);
      await database.command({ ping: 1 });
      return { client, database };
    } catch (error: unknown) {
      lastError = error;
      await client.close().catch(() => undefined);
      if (attempt < options.attempts) await delay(options.delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("MongoDB connection failed for an unspecified reason.");
}
