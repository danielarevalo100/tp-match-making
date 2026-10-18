// Applies one event to the live scoreboard. Atomic, so "check that it was not applied" and "add
// the points" cannot be split by a crash or by a concurrent retry of the same event.
//
// Scoreboard fields: `events`, `lastEventTs` and, per player, `{playerId}:kills|deaths|objectives|
// score|connected|connectionTs`. Counters are commutative, so events may arrive in any order;
// connection state keeps the value of the newest timestamp (disconnect wins a tie).
//
// KEYS: applied event ids (SET), scoreboard (HASH), live match (HASH, written by problem 2).
// ARGV: eventId, type, playerId, targetPlayerId ('' when none), points, tsMs.
// Replies: 'APPLIED' | 'DUPLICATE' | 'NOT_LIVE'.
export const applyEventScript = `
if redis.call('EXISTS', KEYS[3]) == 0 then return 'NOT_LIVE' end
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then return 'DUPLICATE' end

local board = KEYS[2]
local kind = ARGV[2]
local player = ARGV[3]
local tsMs = tonumber(ARGV[6])

redis.call('HINCRBY', board, 'events', 1)
if tsMs > tonumber(redis.call('HGET', board, 'lastEventTs') or '0') then
  redis.call('HSET', board, 'lastEventTs', ARGV[6])
end

if kind == 'kill' then
  redis.call('HINCRBY', board, player .. ':kills', 1)
  redis.call('HINCRBY', board, player .. ':score', ARGV[5])
  if ARGV[4] ~= '' then redis.call('HINCRBY', board, ARGV[4] .. ':deaths', 1) end
elseif kind == 'objective' then
  redis.call('HINCRBY', board, player .. ':objectives', 1)
  redis.call('HINCRBY', board, player .. ':score', ARGV[5])
elseif kind == 'disconnect' or kind == 'reconnect' then
  local seen = tonumber(redis.call('HGET', board, player .. ':connectionTs') or '0')
  if tsMs > seen or (tsMs == seen and kind == 'disconnect') then
    redis.call('HSET', board,
      player .. ':connectionTs', ARGV[6],
      player .. ':connected', kind == 'reconnect' and '1' or '0')
  end
end
return 'APPLIED'
`;
