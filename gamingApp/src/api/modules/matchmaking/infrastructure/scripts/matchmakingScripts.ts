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

// ---------------------------------------------------------------------------
// Match formation (problem 2)
// ---------------------------------------------------------------------------

// Step A of the formation saga. Atomic and all-or-nothing: either every ticket is
// still queued and the whole group moves to a "reserved" formation, or nothing
// is written and the missing players are reported.
// KEYS: formation, formation index, rating queue, wait queue, n tickets, n active matches.
// ARGV: matchId, now (ms), n, n playerIds, n ticketIds.
export const reserveFormationScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {'EXISTS', redis.call('HGET', KEYS[1], 'status')}
end

local n = tonumber(ARGV[3])
local missing = {}
for i = 1, n do
  if redis.call('HGET', KEYS[4 + i], 'ticketId') ~= ARGV[3 + n + i] then
    table.insert(missing, ARGV[3 + i])
  end
end
if #missing > 0 then
  table.insert(missing, 1, 'MISSING')
  return missing
end

local snapshot = {}
for i = 1, n do
  local fields = redis.call('HGETALL', KEYS[4 + i])
  local ticket = {}
  for j = 1, #fields, 2 do ticket[fields[j]] = fields[j + 1] end
  table.insert(snapshot, ticket)
end

redis.call('HSET', KEYS[1],
  'status', 'reserved',
  'matchId', ARGV[1],
  'createdAt', ARGV[2],
  'tickets', cjson.encode(snapshot))

for i = 1, n do
  redis.call('ZREM', KEYS[3], ARGV[3 + i])
  redis.call('ZREM', KEYS[4], ARGV[3 + i])
  redis.call('DEL', KEYS[4 + i])
  redis.call('SET', KEYS[4 + n + i], ARGV[1])
end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return {'RESERVED'}
`;

// Last step of the saga: publishes the live match. Idempotent on "committed".
// Refuses to commit if a reserved player left in the meantime.
// KEYS: formation, formation index, live match. ARGV: matchId, mode, region, now (ms), players (csv).
export const commitFormationScript = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'committed' then return {'COMMITTED'} end
if status ~= 'reserved' then return {'INVALID', status or 'none'} end

local fields = redis.call('HKEYS', KEYS[1])
for _, field in ipairs(fields) do
  if string.sub(field, 1, 10) == 'abandoned:' then return {'ABANDONED'} end
end

redis.call('HSET', KEYS[3],
  'matchId', ARGV[1],
  'mode', ARGV[2],
  'region', ARGV[3],
  'status', 'in_progress',
  'startedAt', ARGV[4],
  'players', ARGV[5])
redis.call('HSET', KEYS[1], 'status', 'committed')
redis.call('ZREM', KEYS[2], ARGV[1])
return {'COMMITTED'}
`;

// Compensation: puts every reserved player (except those who left) back in the
// queue with the original mmr and enqueuedAt, so they keep their seniority.
// Idempotent: a second run finds "rolled_back" and does nothing.
// KEYS: formation, formation index, rating queue, wait queue, live match,
//       n tickets, n active matches (same order as the snapshot).
// ARGV: matchId.
export const restoreFormationScript = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return {'NOT_FOUND'} end
if status == 'rolled_back' then return {'ALREADY_ROLLED_BACK'} end
if status == 'committed' then return {'COMMITTED'} end

local snapshot = cjson.decode(redis.call('HGET', KEYS[1], 'tickets'))
local n = #snapshot
local restored = {'ROLLED_BACK'}
for i, ticket in ipairs(snapshot) do
  if redis.call('HEXISTS', KEYS[1], 'abandoned:' .. ticket.playerId) == 0 then
    if redis.call('EXISTS', KEYS[5 + i]) == 0 then
      redis.call('HSET', KEYS[5 + i],
        'ticketId', ticket.ticketId,
        'playerId', ticket.playerId,
        'mode', ticket.mode,
        'region', ticket.region,
        'mmr', ticket.mmr,
        'enqueuedAt', ticket.enqueuedAt)
      redis.call('ZADD', KEYS[3], ticket.mmr, ticket.playerId)
      redis.call('ZADD', KEYS[4], ticket.enqueuedAt, ticket.playerId)
      table.insert(restored, ticket.playerId)
    end
    if redis.call('GET', KEYS[5 + n + i]) == ARGV[1] then
      redis.call('DEL', KEYS[5 + n + i])
    end
  end
end

redis.call('DEL', KEYS[5])
redis.call('HSET', KEYS[1], 'status', 'rolled_back')
redis.call('ZREM', KEYS[2], ARGV[1])
return restored
`;

// A reserved player leaves while the match is still forming: the formation
// remembers it so that commit refuses and restore skips that player.
// KEYS: formation, player's active match. ARGV: playerId, matchId.
export const abandonFormationScript = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'reserved' then return 0 end
redis.call('HSET', KEYS[1], 'abandoned:' .. ARGV[1], '1')
redis.call('DEL', KEYS[2])
return 1
`;
