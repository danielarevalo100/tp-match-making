export const enqueueScript = `
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

// KEYS: ticket, rating queue, wait queue. ARGV: playerId, ticketId.
// The queue keys depend on the ticket's mode and region, so the caller reads the
// ticket first; the ticketId check makes the removal a no-op if the ticket was
// replaced in between (the caller then retries with the fresh one).
export const leaveScript = `
if redis.call('HGET', KEYS[1], 'ticketId') ~= ARGV[2] then
  return 0
end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`;
