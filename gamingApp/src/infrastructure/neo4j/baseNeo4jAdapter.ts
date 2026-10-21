import neo4j, {
  Neo4jError,
  type Driver,
  type ManagedTransaction,
  type Record as Neo4jRecord,
} from "neo4j-driver";

import { BaseAdapter } from "../baseAdapter.js";
import type { Neo4jConnection } from "./neo4jConnection.js";

export abstract class BaseNeo4jAdapter extends BaseAdapter {
  protected readonly engine = "neo4j";
  private readonly driver: Driver;
  private readonly database: string;

  constructor(connection: Neo4jConnection) {
    super();
    this.driver = connection.driver;
    this.database = connection.database;
  }

  protected isDriverError(error: unknown): boolean {
    return error instanceof Neo4jError;
  }

  protected query(
    step: string,
    mode: "read" | "write",
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<Neo4jRecord[]> {
    return this.run(step, async () => {
      const session = this.driver.session({
        database: this.database,
        defaultAccessMode: mode === "read" ? neo4j.session.READ : neo4j.session.WRITE,
      });
      try {
        const work = async (transaction: ManagedTransaction): Promise<Neo4jRecord[]> =>
          (await transaction.run(cypher, parameters)).records;
        return mode === "read" ? await session.executeRead(work) : await session.executeWrite(work);
      } finally {
        await session.close();
      }
    });
  }
}

/** Neo4j integers come back as `Integer` (or bigint), never as plain numbers. */
export function toNumber(value: unknown): number {
  return neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value);
}
