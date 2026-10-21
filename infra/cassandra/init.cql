-- Keyspace and tables are applied idempotently by scripts/initialize-infrastructure.*.
-- Add a table only together with the query it serves (see docs/problema3.md).
CREATE KEYSPACE IF NOT EXISTS gaming
WITH replication = {
  'class': 'SimpleStrategy',
  'replication_factor': 1
};

-- Problems 3 and 4: append-only log of everything that happens during a match,
-- including the lifecycle event `match_finished` (which has no player_id).
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

-- Problem 6: match history of each player, written once when a match is closed and never updated.
-- Queries served:
--   * the last N matches of a player            (WHERE player_id = ? LIMIT N)
--   * a player's matches in a period            (WHERE player_id = ? AND ended_at >= ? [AND ended_at < ?])
-- One partition per player, newest first: both queries read a contiguous slice of one partition.
-- A player plays a bounded number of matches, so the partition cannot grow without limit.
-- (player_id, ended_at, match_id) is the idempotency key: projecting the same match again
-- overwrites the same row.
CREATE TABLE IF NOT EXISTS gaming.match_history_by_player (
  player_id    uuid,
  ended_at     timestamp,
  match_id     uuid,
  mode         text,
  region       text,
  result       text,
  kills        int,
  deaths       int,
  objectives   int,
  score        int,
  mmr_before   int,
  mmr_after    int,
  rating_delta int,
  PRIMARY KEY ((player_id), ended_at, match_id)
) WITH CLUSTERING ORDER BY (ended_at DESC, match_id ASC);
