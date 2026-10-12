-- Base keyspace only. Add tables after defining the required query patterns.
CREATE KEYSPACE IF NOT EXISTS gaming
WITH replication = {
  'class': 'SimpleStrategy',
  'replication_factor': 1
};
