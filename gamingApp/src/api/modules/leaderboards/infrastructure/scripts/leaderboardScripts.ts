// KEYS: board (global or regional sorted set).
// ARGV: limit.
// Total and slice come from one script so they describe the same moment.
export const topScript = `
return {
  redis.call('ZCARD', KEYS[1]),
  redis.call('ZREVRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1, 'WITHSCORES')
}
`;

// KEYS: board.
// ARGV: playerId, radius.
// Rank and neighbours are read atomically: with two separate commands a match closing in between
// could return neighbours that do not surround the returned position.
export const aroundScript = `
local rank = redis.call('ZREVRANK', KEYS[1], ARGV[1])
if not rank then return false end
local first = rank - tonumber(ARGV[2])
if first < 0 then first = 0 end
local rows = redis.call('ZREVRANGE', KEYS[1], first, rank + tonumber(ARGV[2]), 'WITHSCORES')
return { rank, first, redis.call('ZCARD', KEYS[1]), rows }
`;

// KEYS: global board, members hash (playerId -> "revision|region"), held hash (problem 8).
// ARGV: regional key prefix, then playerId, mmr, region, revision for each standing.
// The members hash remembers which regional board holds each player, so a region change moves the
// player instead of leaving them in two boards. A standing older than the stored revision is
// skipped, which makes retries and out-of-order publications harmless. A player held by a sanction
// reversal (problem 8) is skipped too: the reversal publishes it when it finishes, so the board
// never shows a reversal half applied. The old regional key is built from the prefix: fine on a
// single Redis node, a cluster would need hash tags.
export const publishScript = `
local published = 0
for i = 2, #ARGV, 4 do
  local playerId, mmr, region, revision = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3]
  local stored = redis.call('HGET', KEYS[2], playerId)
  local storedRevision, storedRegion = -1, nil
  if stored then
    local separator = string.find(stored, '|', 1, true)
    storedRevision = tonumber(string.sub(stored, 1, separator - 1))
    storedRegion = string.sub(stored, separator + 1)
  end
  if not redis.call('HGET', KEYS[3], playerId) and tonumber(revision) >= storedRevision then
    -- An empty region is the tombstone a sanction reversal leaves when it removes a player.
    if storedRegion and storedRegion ~= '' and storedRegion ~= region then
      redis.call('ZREM', ARGV[1] .. storedRegion, playerId)
    end
    redis.call('ZADD', KEYS[1], mmr, playerId)
    redis.call('ZADD', ARGV[1] .. region, mmr, playerId)
    redis.call('HSET', KEYS[2], playerId, revision .. '|' .. region)
    published = published + 1
  end
end
return published
`;

// KEYS: global board, members hash, held hash (problem 8).
// ARGV: regional key prefix, then the player ids to remove.
// A player held by a sanction reversal stays: the reversal decides what the board shows for it.
export const removeScript = `
local removed = 0
for i = 2, #ARGV do
  if not redis.call('HGET', KEYS[3], ARGV[i]) then
    local stored = redis.call('HGET', KEYS[2], ARGV[i])
    if stored then
      local region = string.sub(stored, string.find(stored, '|', 1, true) + 1)
      redis.call('ZREM', ARGV[1] .. region, ARGV[i])
      redis.call('HDEL', KEYS[2], ARGV[i])
      removed = removed + 1
    end
    redis.call('ZREM', KEYS[1], ARGV[i])
  end
end
return removed
`;

// KEYS: rebuild lock. ARGV: token, ttl in milliseconds.
// Only the rebuild that took the lock can extend it: a rebuild whose lock expired and was taken by
// another one gets 0 and must stop.
export const extendLockScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

// KEYS: rebuild lock. ARGV: token.
// Compare and delete in one step, so a rebuild never frees a lock another rebuild holds.
export const releaseLockScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

// Problem 8, before any rating is reverted.
// KEYS: holds set ("holdId|playerId"), held hash (playerId -> number of holds).
// ARGV: holdId, then the player ids to hold.
// The set makes the hold idempotent (a retry does not count twice) and the counter lets two
// reversals that touch the same player hold it at the same time.
export const holdScript = `
local held = 0
for i = 2, #ARGV do
  if redis.call('SADD', KEYS[1], ARGV[1] .. '|' .. ARGV[i]) == 1 then
    redis.call('HINCRBY', KEYS[2], ARGV[i], 1)
    held = held + 1
  end
end
return held
`;

// Problem 8, last step of a sanction reversal: one call per board, so a reader sees either none
// or all of the reversal in that board.
// KEYS: global board, members hash, holds set, held hash.
// ARGV: regional key prefix, holdId, then playerId, mmr, region, revision, action per player.
// action: "publish" (the player still has matches in the season), "remove" (every match it played
// in the season was voided) or "release" (no standing: only the hold is dropped).
// The hold is dropped first; a player that another reversal still holds is left for that one. A
// removal keeps "revision|" in the members hash as a tombstone, so a publication older than the
// removal cannot bring the player back.
export const releaseScript = `
local applied = 0
for i = 3, #ARGV, 5 do
  local playerId, mmr, region, revision, action =
    ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3], ARGV[i + 4]
  if redis.call('SREM', KEYS[3], ARGV[2] .. '|' .. playerId) == 1 then
    if redis.call('HINCRBY', KEYS[4], playerId, -1) <= 0 then
      redis.call('HDEL', KEYS[4], playerId)
    end
  end
  if action ~= 'release' and not redis.call('HGET', KEYS[4], playerId) then
    local stored = redis.call('HGET', KEYS[2], playerId)
    local storedRevision, storedRegion = -1, nil
    if stored then
      local separator = string.find(stored, '|', 1, true)
      storedRevision = tonumber(string.sub(stored, 1, separator - 1))
      storedRegion = string.sub(stored, separator + 1)
    end
    if tonumber(revision) >= storedRevision then
      if storedRegion and storedRegion ~= '' and (action == 'remove' or storedRegion ~= region) then
        redis.call('ZREM', ARGV[1] .. storedRegion, playerId)
      end
      if action == 'publish' then
        redis.call('ZADD', KEYS[1], mmr, playerId)
        redis.call('ZADD', ARGV[1] .. region, mmr, playerId)
        redis.call('HSET', KEYS[2], playerId, revision .. '|' .. region)
      else
        redis.call('ZREM', KEYS[1], playerId)
        redis.call('HSET', KEYS[2], playerId, revision .. '|')
      end
      applied = applied + 1
    end
  end
end
return applied
`;
