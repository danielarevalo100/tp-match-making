export const beginClosingScript = `
local releasedClosure = redis.call('HGET', KEYS[2], 'closureId')
if releasedClosure == ARGV[1] and redis.call('HGET', KEYS[2], 'status') == 'released' then
  return 'RELEASED'
end

if redis.call('EXISTS', KEYS[1]) == 0 then return 'NOT_LIVE' end
local status = redis.call('HGET', KEYS[1], 'status')
local currentClosure = redis.call('HGET', KEYS[1], 'closureId')
if status == 'closing' and currentClosure == ARGV[1] then return 'REPLAYED' end
if status ~= 'in_progress' then return 'CONFLICT|' .. (status or 'missing') end

redis.call('HSET', KEYS[1], 'status', 'closing', 'closureId', ARGV[1])
return 'CLOSING'
`;

export const rollbackClosingScript = `
if redis.call('HGET', KEYS[1], 'status') ~= 'closing' then return 0 end
if redis.call('HGET', KEYS[1], 'closureId') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'in_progress')
redis.call('HDEL', KEYS[1], 'closureId')
return 1
`;

// KEYS: partida en vivo, marcador, ids aplicados, marca de liberación, N claves active_match.
// ARGV: closureId, matchId, releasedAt, markerTtlSeconds, N ids de jugadores.
export const releaseMatchScript = `
if redis.call('HGET', KEYS[4], 'closureId') == ARGV[1]
  and redis.call('HGET', KEYS[4], 'status') == 'released' then
  return 'ALREADY_RELEASED'
end

if redis.call('EXISTS', KEYS[1]) == 0 then return 'NOT_LIVE' end
if redis.call('HGET', KEYS[1], 'status') ~= 'closing' then return 'CONFLICT|status' end
if redis.call('HGET', KEYS[1], 'closureId') ~= ARGV[1] then return 'CONFLICT|closure' end

local n = #KEYS - 4
for i = 1, n do
  local active = redis.call('GET', KEYS[4 + i])
  if active and active ~= ARGV[2] then
    return 'CONFLICT|player|' .. ARGV[4 + i]
  end
end

for i = 1, n do
  if redis.call('GET', KEYS[4 + i]) == ARGV[2] then
    redis.call('DEL', KEYS[4 + i])
  end
end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
redis.call('HSET', KEYS[4],
  'closureId', ARGV[1],
  'status', 'released',
  'releasedAt', ARGV[3])
redis.call('EXPIRE', KEYS[4], ARGV[4])
return 'RELEASED'
`;
