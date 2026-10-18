-- Keyspace and tables are applied idempotently by scripts/initialize-infrastructure.*.
-- Add a table only together with the query it serves (see docs/problema3.md).
CREATE KEYSPACE IF NOT EXISTS gaming
WITH replication = {
  'class': 'SimpleStrategy',
  'replication_factor': 1
};

-- Problem 3: append-only log of everything that happens during a match.
-- Queries served:
--   * all events of a match, in order            (WHERE match_id = ?)
--   * events of a match within a time range      (WHERE match_id = ? AND ts >= ? AND ts <= ?)
-- One partition per match: a match has a bounded number of events, so it cannot grow forever.
-- event_id is the idempotency key: inserting the same (match_id, ts, event_id) again overwrites
-- the same row, and it also tells apart events that happen in the same millisecond.
CREATE TABLE IF NOT EXISTS gaming.events_by_match (
  match_id         uuid,
  ts               timestamp,
  event_id         uuid,
  event_type       text,
  player_id        uuid,
  target_player_id uuid,
  detail           text,
  points           int,
  PRIMARY KEY ((match_id), ts, event_id)
) WITH CLUSTERING ORDER BY (ts ASC, event_id ASC);
