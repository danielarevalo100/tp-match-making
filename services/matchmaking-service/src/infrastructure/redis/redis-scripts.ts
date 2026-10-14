// Lua scripts run atomically inside Redis: no other command is interleaved, so
// "check, then write" cannot race with a concurrent request for the same
// player. They live in TypeScript (not .lua files) because `tsc` only emits
// .ts files into dist/.

// KEYS: ticket, active match, rating ZSET, wait ZSET
// ARGV: playerId, ticketId, mode, region, mmr, enqueuedAt (ms)
// Returns {status, ...}:
//   {"ENQUEUED"}                         ticket written
//   {"REPLAYED", ...hash}                same ticketId already queued (idempotent)
//   {"ALREADY_IN_QUEUE", ...hash}        queued with a different ticketId
//   {"ALREADY_IN_MATCH", matchId}        player has an active match
export const ENQUEUE_SCRIPT = `
local existing = redis.call('HGETALL', KEYS[1])
if #existing > 0 then
  local status = 'ALREADY_IN_QUEUE'
  if redis.call('HGET', KEYS[1], 'ticketId') == ARGV[2] then
    status = 'REPLAYED'
  end
  table.insert(existing, 1, status)
  return existing
end

local matchId = redis.call('GET', KEYS[2])
if matchId then
  return {'ALREADY_IN_MATCH', matchId}
end

redis.call('HSET', KEYS[1],
  'ticketId', ARGV[2],
  'playerId', ARGV[1],
  'mode', ARGV[3],
  'region', ARGV[4],
  'mmr', ARGV[5],
  'enqueuedAt', ARGV[6])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[6], ARGV[1])
return {'ENQUEUED'}
`;

// KEYS: ticket. ARGV: playerId.
// Removes the ticket and its entries in both ZSETs. The queue keys are derived
// from the ticket itself, so this script is for a standalone Redis (not
// Cluster) where undeclared keys are allowed.
export const LEAVE_SCRIPT = `
local mode = redis.call('HGET', KEYS[1], 'mode')
if not mode then
  return 0
end
local region = redis.call('HGET', KEYS[1], 'region')
redis.call('ZREM', 'mm:q:' .. mode .. ':' .. region .. ':rating', ARGV[1])
redis.call('ZREM', 'mm:q:' .. mode .. ':' .. region .. ':wait', ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`;
