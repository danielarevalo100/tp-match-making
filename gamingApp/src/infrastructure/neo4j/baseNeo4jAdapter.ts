import neo4j, { Neo4jError, type Driver, type Record as Neo4jRecord } from "neo4j-driver";

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

  /** Ejecuta una consulta Cypher en una transacción de lectura o de escritura. */
  protected query(
    mode: "read" | "write",
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<Neo4jRecord[]> {
    const run = async (): Promise<Neo4jRecord[]> => {
      const session = this.driver.session({ database: this.database });
      try {
        const result =
          mode === "read"
            ? await session.executeRead((transaction) => transaction.run(cypher, parameters))
            : await session.executeWrite((transaction) => transaction.run(cypher, parameters));
        return result.records;
      } finally {
        await session.close();
      }
    };
    return mode === "read" ? this.read(run) : this.write(run);
  }
}

/** Los enteros de Neo4j llegan como `Integer` (o bigint), nunca como number. */
export function toNumber(value: unknown): number {
  return neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value);
}
