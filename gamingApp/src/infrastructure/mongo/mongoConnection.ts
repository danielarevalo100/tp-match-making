import { MongoClient, type Db } from "mongodb";

import { retry } from "../retry.js";

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

export function connectToMongo(options: MongoConnectionOptions): Promise<MongoConnection> {
  return retry(options.attempts, options.delayMs, async () => {
    const client = new MongoClient(options.uri, { appName: options.appName });
    try {
      await client.connect();
      const database = client.db(options.databaseName);
      await database.command({ ping: 1 });
      return { client, database };
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      throw error;
    }
  });
}
