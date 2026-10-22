import { Client, types } from "cassandra-driver";

import { retry } from "../retry.js";

type CassandraConnectionOptions = {
  attempts: number;
  contactPoints: readonly string[];
  delayMs: number;
  keyspace: string;
  localDataCenter: string;
  port: number;
};

// El keyspace tiene que existir (infra/cassandra/init.cql); si no, todos los intentos fallan.
export function connectToCassandra(options: CassandraConnectionOptions): Promise<Client> {
  return retry(options.attempts, options.delayMs, async () => {
    const client = new Client({
      contactPoints: options.contactPoints.map((host) => `${host}:${options.port}`),
      keyspace: options.keyspace,
      localDataCenter: options.localDataCenter,
      queryOptions: {
        // Con replication_factor 1 es lo mismo que ONE; con más réplicas una escritura solo se
        // confirma cuando la tiene la mayoría, así un evento confirmado no se pierde.
        consistency: types.consistencies.localQuorum,
        prepare: true,
      },
    });

    try {
      await client.connect();
      return client;
    } catch (error: unknown) {
      await client.shutdown().catch(() => undefined);
      throw error;
    }
  });
}
