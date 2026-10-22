// KEYS: tablero (sorted set global o regional).
// ARGV: limit.
// Total y porción salen del mismo script, así describen el mismo momento.
export const topScript = `
return {
  redis.call('ZCARD', KEYS[1]),
  redis.call('ZREVRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1, 'WITHSCORES')
}
`;

// KEYS: tablero.
// ARGV: playerId, radius.
// Rank y vecinos se leen de forma atómica: con dos comandos separados, una partida que se cierra
// en el medio podría devolver vecinos que no rodean a la posición devuelta.
export const aroundScript = `
local rank = redis.call('ZREVRANK', KEYS[1], ARGV[1])
if not rank then return false end
local first = rank - tonumber(ARGV[2])
if first < 0 then first = 0 end
local rows = redis.call('ZREVRANGE', KEYS[1], first, rank + tonumber(ARGV[2]), 'WITHSCORES')
return { rank, first, redis.call('ZCARD', KEYS[1]), rows }
`;

// Función Lua que comparten los scripts que escriben tableros: lee "revision|region" del hash de
// miembros. Devuelve -1 y nil si el jugador no está.
const readMember = `
local function readMember(members, playerId)
  local stored = redis.call('HGET', members, playerId)
  if not stored then return -1, nil end
  local separator = string.find(stored, '|', 1, true)
  return tonumber(string.sub(stored, 1, separator - 1)), string.sub(stored, separator + 1)
end
`;

// KEYS: tablero global, hash de miembros (playerId -> "revision|region"), hash de retenidos (problema 8).
// ARGV: prefijo de las claves regionales, y por cada standing: playerId, mmr, region, revision.
// El hash de miembros recuerda en qué tablero regional está cada jugador, así un cambio de región
// lo mueve en lugar de dejarlo en dos tableros. Un standing más viejo que la revisión guardada se
// saltea, lo que hace inofensivos los reintentos y las publicaciones fuera de orden. Un jugador
// retenido por una reversión de sanción (problema 8) también se saltea: la reversión lo publica al
// terminar, así el tablero nunca muestra una reversión a medias. La clave regional vieja se arma
// con el prefijo: sirve en un solo nodo de Redis, un cluster necesitaría hash tags.
export const publishScript = `${readMember}
local published = 0
for i = 2, #ARGV, 4 do
  local playerId, mmr, region, revision = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3]
  local storedRevision, storedRegion = readMember(KEYS[2], playerId)
  if not redis.call('HGET', KEYS[3], playerId) and tonumber(revision) >= storedRevision then
    -- Una región vacía es la marca que deja una reversión de sanción al sacar a un jugador.
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

// KEYS: tablero global, hash de miembros, hash de retenidos (problema 8).
// ARGV: prefijo de las claves regionales, y los ids de los jugadores a sacar.
// Un jugador retenido por una reversión de sanción se queda: la reversión decide qué muestra.
export const removeScript = `${readMember}
local removed = 0
for i = 2, #ARGV do
  if not redis.call('HGET', KEYS[3], ARGV[i]) then
    local _, region = readMember(KEYS[2], ARGV[i])
    if region then
      redis.call('ZREM', ARGV[1] .. region, ARGV[i])
      redis.call('HDEL', KEYS[2], ARGV[i])
      removed = removed + 1
    end
    redis.call('ZREM', KEYS[1], ARGV[i])
  end
end
return removed
`;

// Problema 8, antes de revertir cualquier rating.
// KEYS: set de retenciones ("holdId|playerId"), hash de retenidos (playerId -> cantidad de retenciones).
// ARGV: holdId, y los ids de los jugadores a retener.
// El set hace idempotente la retención (un reintento no cuenta dos veces) y el contador permite
// que dos reversiones que tocan al mismo jugador lo retengan al mismo tiempo.
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

// Problema 8, último paso de la reversión de una sanción: una llamada por tablero, así un lector
// ve toda la reversión en ese tablero o nada.
// KEYS: tablero global, hash de miembros, set de retenciones, hash de retenidos.
// ARGV: prefijo de las claves regionales, holdId, y por jugador: playerId, mmr, region, revision, acción.
// Acción: "publish" (al jugador le quedan partidas en la temporada), "remove" (se anularon todas
// las que jugó en la temporada) o "release" (no tiene standing: solo se quita la retención).
// Primero se quita la retención; a un jugador que otra reversión sigue reteniendo lo publica esa.
// Al sacar a un jugador queda "revision|" en el hash de miembros como marca, así una publicación
// más vieja que la remoción no lo puede volver a agregar.
export const releaseScript = `${readMember}
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
    local storedRevision, storedRegion = readMember(KEYS[2], playerId)
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
