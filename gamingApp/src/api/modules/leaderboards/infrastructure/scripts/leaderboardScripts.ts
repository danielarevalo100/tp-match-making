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

// KEYS: global board, members hash (playerId -> "revision|region").
// ARGV: regional key prefix, then playerId, mmr, region, revision for each standing.
// The members hash remembers which regional board holds each player, so a region change moves the
// player instead of leaving them in two boards. A standing older than the stored revision is
// skipped, which makes retries and out-of-order publications harmless. The old regional key is
// built from the prefix: fine on a single Redis node, a cluster would need hash tags.
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
  if tonumber(revision) >= storedRevision then
    if storedRegion and storedRegion ~= region then
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

// KEYS: global board, members hash.
// ARGV: regional key prefix, then the player ids to remove.
export const removeScript = `
local removed = 0
for i = 2, #ARGV do
  local stored = redis.call('HGET', KEYS[2], ARGV[i])
  if stored then
    local region = string.sub(stored, string.find(stored, '|', 1, true) + 1)
    redis.call('ZREM', ARGV[1] .. region, ARGV[i])
    redis.call('HDEL', KEYS[2], ARGV[i])
    removed = removed + 1
  end
  redis.call('ZREM', KEYS[1], ARGV[i])
end
return removed
`;
