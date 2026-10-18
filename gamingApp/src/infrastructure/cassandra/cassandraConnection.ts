import { Client, types } from "cassandra-driver";

type CassandraConnectionOptions = {
  attempts: number;
  contactPoints: readonly string[];
  delayMs: number;
  keyspace: string;
  localDataCenter: string;
  port: number;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The keyspace must already exist (infra/cassandra/init.cql), otherwise every attempt fails.
export async function connectToCassandra(options: CassandraConnectionOptions): Promise<Client> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
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
      lastError = error;
      await client.shutdown().catch(() => undefined);
      if (attempt < options.attempts) await delay(options.delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Cassandra connection failed for an unspecified reason.");
}
