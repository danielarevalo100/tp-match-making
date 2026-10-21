import neo4j, { type Driver } from "neo4j-driver";

import { retry } from "../retry.js";

export type Neo4jConnection = {
  database: string;
  driver: Driver;
};

type Neo4jConnectionOptions = {
  attempts: number;
  database: string;
  delayMs: number;
  password: string;
  uri: string;
  username: string;
};

export function connectToNeo4j(options: Neo4jConnectionOptions): Promise<Neo4jConnection> {
  return retry(options.attempts, options.delayMs, async () => {
    const driver = neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password));
    try {
      await driver.verifyConnectivity({ database: options.database });
      return { database: options.database, driver };
    } catch (error: unknown) {
      await driver.close().catch(() => undefined);
      throw error;
    }
  });
}
