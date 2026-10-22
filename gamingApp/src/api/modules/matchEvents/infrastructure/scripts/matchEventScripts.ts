// Aplica un evento al marcador en vivo. Es atómico, así "ver que no se aplicó" y "sumar los
// puntos" no se pueden separar por una caída o por un reintento concurrente del mismo evento.
//
// Campos del marcador: `events`, `lastEventTs` y, por jugador, `{playerId}:kills|deaths|objectives|
// score|connected|connectionTs`. Los contadores son conmutativos, así los eventos pueden llegar en
// cualquier orden; el estado de conexión se queda con el timestamp más nuevo (en empate gana la
// desconexión).
//
// KEYS: ids de eventos aplicados (SET), marcador (HASH), partida en vivo (HASH, la escribe el problema 2).
// ARGV: eventId, type, playerId, targetPlayerId ('' si no hay), points, tsMs.
// Respuestas: 'APPLIED' | 'DUPLICATE' | 'NOT_LIVE'.
export const applyEventScript = `
if redis.call('HGET', KEYS[3], 'status') ~= 'in_progress' then return 'NOT_LIVE' end
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
