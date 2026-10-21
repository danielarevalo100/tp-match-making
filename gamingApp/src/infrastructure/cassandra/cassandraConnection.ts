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

// The keyspace must already exist (infra/cassandra/init.cql), otherwise every attempt fails.
export function connectToCassandra(options: CassandraConnectionOptions): Promise<Client> {
  return retry(options.attempts, options.delayMs, async () => {
    const client = new Client({
      contactPoints: options.contactPoints.map((host) => `${host}:${options.port}`),
      keyspace: options.keyspace,
      localDataCenter: options.localDataCenter,
      queryOptions: {
        // With replication_factor 1 this is the same as ONE; with more replicas a write is
        // only acknowledged once a majority has it, so an acknowledged event is not lost.
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
