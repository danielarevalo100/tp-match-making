import neo4j, { type Driver } from "neo4j-driver";

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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function connectToNeo4j(options: Neo4jConnectionOptions): Promise<Neo4jConnection> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const driver = neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password));
    try {
      await driver.verifyConnectivity({ database: options.database });
      return { database: options.database, driver };
    } catch (error: unknown) {
      lastError = error;
      await driver.close().catch(() => undefined);
      if (attempt < options.attempts) await delay(options.delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Neo4j connection failed for an unspecified reason.");
}
