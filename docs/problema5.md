# Problema 5 — Consulta del leaderboard

## Consigna adoptada

> Obtener el top 100 de un modo y temporada, global o regional, y la posición de un jugador junto con los cinco jugadores por encima y por debajo de él, con tiempos de respuesta en milisegundos.

Es un problema de **consulta**: combina datos de dos motores y no escribe nada. Las escrituras que mantienen el leaderboard pertenecen a P4 (cierre de partida) y quedan documentadas acá porque definen qué se consulta.

### Qué significa "temporada"

- La partida cuenta para la temporada **activa** que contiene su `createdAt` (cuando P2 la formó), y solo si el modo es `ranked`. La regla depende de datos fijos de la partida, así que un reintento siempre elige la misma temporada.
- Cada jugador tiene un registro por temporada y modo (`seasonRatings`, ver [Modelo de datos](#modelo-de-datos)). Su `mmr` es el rating del modo después de la última partida del jugador en esa temporada, y su `gamesPlayed` cuenta las partidas de esa temporada (`partidas_jugadas_periodo` del DER).
- El MMR no se reinicia por temporada. Matchmaking sigue usando `ratings.<mode>.mmr`, y la temporada define **quién figura** y con qué valor quedó al cerrarla. Cuando la temporada se cierra, su tabla queda congelada porque ninguna partida nueva la toca.
- `region` es la región del jugador al jugar. Se guarda en el registro para que la tabla regional de temporadas pasadas no cambie si el jugador se muda.

Si más adelante se quiere un reinicio por temporada (por ejemplo, un reset suave), alcanza con cambiar el valor inicial de `seasonRatings` en P4: las consultas no cambian.

## Motores y responsabilidades

| Motor | Responsabilidad | Dato |
|---|---|---|
| **MongoDB** | Fuente de verdad del rating y del registro por temporada; catálogos; perfil para mostrar. | `players.ratings.<mode>`, `players.seasonRatings.<season>.<mode>`, `seasons`, `game_modes`, `regions`, `username`/`country`. |
| **Redis** | Dueño del **ranking**: el orden y la posición de cada jugador. Ningún otro motor resuelve la posición en O(log N). | Sorted sets `lb:{season}:{mode}:global` y `lb:{season}:{mode}:region:{region}`, más el hash `lb:{season}:{mode}:members`. |

Redis no replica una consulta que Mongo ya resuelve: aporta una operación que Mongo no tiene, la posición de un elemento dentro de un orden que cambia en cada partida. En el DER, `ENTRADA_LEADERBOARD.posicion` es un dato derivado (recomendación 13): vive solo en Redis y se recalcula sola con cada `ZADD`. La comparación con los demás motores está en [Preguntas contrafactuales](#preguntas-contrafactuales-para-el-informe).

## Identificadores

- `playerId`: el UUID de `players._id` (P1). Es el miembro de los ZSET y el campo del hash `members`. Une el resultado de Redis con los perfiles de Mongo (`find({_id: {$in: ids}})`). **No se genera acá.**
- `seasonId` (`seasons._id`, p. ej. `2026-S2`) y `mode` (`game_modes._id`, p. ej. `ranked_1v1`): son parte de las claves Redis y de la ruta `seasonRatings.<seasonId>.<mode>` en Mongo. La API solo acepta identificadores con formato de catálogo, porque terminan dentro de claves y rutas de campo.
- `region` (`regions._id`): sufijo de la clave del tablero regional.
- `matchId`: el de P2. No figura en el leaderboard. P4 lo usa para aplicar el rating una sola vez (`appliedRatingMatches`) y para marcar la publicación en `matches.leaderboard`.

Trazabilidad de un jugador: con su `playerId` se lee el registro durable en Mongo (`players.seasonRatings.<season>.<mode>`) y su posición viva en Redis (`ZREVRANK lb:{season}:{mode}:global`). Las dos lecturas usan el mismo id, sin copias intermedias.

## Flujo de lectura

### Secuencia de una consulta

1. **Mongo (catálogos, en paralelo):** la temporada existe, el modo existe y es `ranked`, y la región existe si se pidió.
2. **Redis (un script Lua):**
   - top: `ZCARD` + `ZREVRANGE 0 99 WITHSCORES`;
   - posición: `ZREVRANK` y `ZREVRANGE rank-5 rank+5 WITHSCORES` + `ZCARD`, juntos, para que la posición y los vecinos describan el mismo instante aunque una partida cierre entre ambos comandos.
3. **Mongo:** `find({_id: {$in: ids}})` con proyección de `username`, `country` y el registro de la temporada (≤ 100 lecturas por `_id`).

### Posición y empates

La posición es **ordinal**: 1, 2, 3… sin repetir. Ante igual MMR, Redis ordena por `playerId` en orden lexicográfico descendente. El orden es estable y determinista, aunque arbitrario. La demo verifica la posición contra un conteo independiente en Mongo con ese mismo criterio de desempate.

## Flujo y orden de escrituras (en P4)

El scoring de P4 suma un paso final:

1. `findLeaderboardSeason(mode, createdAt)`: temporada activa y modo `ranked`, o `null`.
2. `applyRating` (Mongo, un solo `updateOne` con pipeline): suma el delta a `ratings.<mode>.mmr` y, en una segunda etapa del mismo update, copia el valor absoluto a `seasonRatings.<season>.<mode>` e incrementa `gamesPlayed` y `revision`. La guarda `appliedRatingMatches != matchId` lo hace idempotente por (partida, jugador).
3. `completeScoring` (Mongo): `finalScoreboard` y `scoringStatus=applied`.
4. **Publicación** (Redis): se leen de Mongo los registros actuales de los jugadores de la partida y un script Lua los escribe en el tablero global y en el regional, de forma atómica para toda la partida.
5. `markLeaderboard` (Mongo): `leaderboard.status = published | not_ranked`.

El orden responde a la condición de falla de P4: *no puede quedar un leaderboard actualizado con un rating o un historial que no lo refleje*. Redis se escribe **último**, así que una falla solo puede dejar el leaderboard **atrasado**, nunca adelantado.

### Qué pasa si falla cada paso

| Falla | Estado | Respuesta | Recuperación |
|---|---|---|---|
| Rating o final scoreboard | `scoringStatus=failed`, Redis intacto | `202`, `leaderboardStatus=pending` | Repetir `finish`; los ratings ya aplicados no se repiten. |
| Publicación en Redis | Rating e historial aplicados, Redis sin cambios | `202`, `scoringStatus=applied`, `leaderboardStatus=pending` | Repetir `finish` solo republica, o `POST .../rebuild`. |
| `markLeaderboard` tras publicar | Redis actualizado, marca pendiente | `202` | El reintento republica (no cambia nada, porque es idempotente) y marca. |

### Idempotencia y orden

Se publica el valor **absoluto** que tiene Mongo con `ZADD`, nunca un `ZINCRBY`. El script compara `revision` con la guardada en `lb:...:members` e ignora una más vieja. Un reintento tardío de una partida anterior no puede pisar el resultado de una partida más nueva del mismo jugador.

### Atomicidad visible

Todos los jugadores de una partida se publican en una sola invocación Lua, así que una consulta nunca ve la partida aplicada a medias. Esto sirve también para P8, que tendrá que recalcular sin dejar tablas con resultados parcialmente anulados.

## Reconstrucción

`POST /leaderboards/:mode/:seasonId/rebuild` hace lo siguiente:

1. Recorre en lotes de 500 los jugadores con `seasonRatings.<season>.<mode>` y los publica con el mismo script con control de revisión que usa P4.
2. Quita de Redis a los miembros que Mongo ya no tiene en la tabla. Antes de borrar vuelve a consultar Mongo, para no quitar a un jugador que entró por primera vez mientras corría el recorrido.

Publica sobre los tableros vivos (sin `RENAME`), así que se puede ejecutar mientras siguen cerrando partidas: el control por `revision` impide retroceder. Sirve para recuperar Redis después de una pérdida de datos y para reparar un `leaderboardStatus=pending`. Recorre todos los jugadores de la temporada y el modo; no es una operación por jugador.

## Modelo de datos

### Mongo — `players.seasonRatings` (`infra/mongo/init.js`, `schema_metadata` v6)

```text
players.seasonRatings.<seasonId>.<modeId> = { mmr, gamesPlayed, region, revision, updatedAt }
```

- `revision` crece con cada cambio y permite que Redis descarte publicaciones viejas.
- `matches.leaderboard = { status: published | not_ranked, updatedAt }` registra que P4 ya publicó la partida.
- La reconstrucción busca por la ruta dinámica `seasonRatings.<season>.<mode>`, que no tiene índice.

### Redis (claves en `shared/storageKeys.ts`, tabla en `infra/redis/README.md`)

| Clave | Tipo | Contenido |
|---|---|---|
| `lb:{season}:{mode}:global` | ZSET | `playerId` → MMR |
| `lb:{season}:{mode}:region:{region}` | ZSET | `playerId` → MMR, solo de esa región |
| `lb:{season}:{mode}:members` | HASH | `playerId` → `"{revision}\|{region}"`: tablero regional actual y última revisión publicada |

El hash `members` permite que un cambio de región **mueva** al jugador (`ZREM` del regional viejo y `ZADD` en el nuevo) en lugar de duplicarlo. El script arma la clave regional anterior a partir del prefijo; en un único nodo Redis funciona, pero en un cluster haría falta usar hash tags.

### Desnormalización

- **MMR**, en tres lugares:
  - `ratings.<mode>.mmr`: el vigente, el que usa matchmaking;
  - `seasonRatings.<season>.<mode>.mmr`: copia del valor al cierre de la última partida del jugador en esa temporada;
  - score del ZSET en Redis.

  Responsable: `MatchClosureService`. Las dos copias de Mongo se escriben en el mismo update atómico y Redis se publica al final. Si Redis queda atrás, se repara con `LeaderboardService.rebuild`.
- **Región**, también en tres lugares: `players.region` → `seasonRatings.<season>.<mode>.region` → tablero regional y hash `members`. P4 la copia en cada partida. Un `PATCH /players` que cambia el país **no** la actualiza (ver [Limitaciones conocidas](#limitaciones-conocidas)).
- **No se duplican** `username`, `country` ni `gamesPlayed` en Redis: se leen de Mongo en cada consulta, para no tener que invalidar copias cuando cambia el perfil.
- **La posición no se guarda en ningún lado:** es derivada y la calcula Redis al consultar.

## API

| Método | Ruta | Propósito |
|---|---|---|
| `GET` | `/leaderboards/:mode/:seasonId?region=LATAM` | Top 100, global o regional |
| `GET` | `/leaderboards/:mode/:seasonId/players/:playerId?region=LATAM` | Posición del jugador y 5 por encima y 5 por debajo |
| `POST` | `/leaderboards/:mode/:seasonId/rebuild` | Reconstruye los tableros de Redis desde Mongo |

Sin `region`, la consulta usa el tablero global. Con `region`, usa el de esa región (se normaliza a mayúsculas).

Ejemplo de posición (resumido):

```json
{
  "mode": "ranked_1v1",
  "seasonId": "2026-S2",
  "seasonStatus": "active",
  "scope": "regional",
  "region": "LATAM",
  "totalPlayers": 8365,
  "player": { "position": 4210, "playerId": "…", "username": "p5_123", "country": "AR", "region": "LATAM", "mmr": 1497, "gamesPlayed": 41 },
  "above": [ "… 5 entradas, la mejor primero …" ],
  "below": [ "… 5 entradas, la mejor primero …" ]
}
```

### Errores

| Caso | HTTP | `error` |
|---|---|---|
| Temporada, modo o región inexistente | 404 | `LEADERBOARD_NOT_FOUND` (`missing`: `season`/`mode`/`region`) |
| Modo sin ranking (`casual_5v5`) | 422 | `MODE_NOT_RANKED` |
| Jugador sin posición en ese tablero | 404 | `PLAYER_NOT_RANKED` |
| Parámetros inválidos | 400 | `VALIDATION_ERROR` |
| Redis o Mongo caído | 503 | `STORAGE_ERROR` |

## Inyección de fallas

```text
leaderboard.findSeason      leaderboard.findMode       leaderboard.findRegion
leaderboard.top             leaderboard.around         leaderboard.findPlayers
leaderboard.publish         leaderboard.listStandings  leaderboard.findStandings
leaderboard.listMembers     leaderboard.remove
matchClosure.findLeaderboardSeason  matchClosure.findStandings  matchClosure.markLeaderboard
```

Ejemplo: `x-fail-at: leaderboard.publish` en un `POST /matches/:id/finish` deja `scoringStatus=applied` y `leaderboardStatus=pending`; repetir el mismo `finish` publica.

## Simulación y resultados

```bash
node scripts/demo-problem-5.mjs
```

Requiere la app, Mongo (con el schema aplicado) y Redis, y las dependencias de `gamingApp` instaladas: usa sus drivers para cargar datos y para simular la pérdida de Redis. Pasos:

1. Carga 50.000 jugadores reproducibles (semilla fija) con registro en `2026-S2 / ranked_1v1`. Reemplaza a los de corridas anteriores.
2. Reconstruye Redis desde Mongo.
3. Verifica el top 100 global y regional, los 5+5 vecinos, y la posición contra un conteo independiente en Mongo.
4. Mide la latencia por la API.
5. Compara `ZREVRANK` con `countDocuments` indexado.
6. Falla inyectada; Redis pierde los tableros y `rebuild` los restaura en la misma posición.

Resultados locales (contenedores Docker en una laptop, app con `tsx`, 50.000 jugadores):

| Medición | p50 | p95 |
|---|---:|---:|
| Top 100 global, API, secuencial | 3,6 ms | 5,3 ms |
| Top 100 regional, API, secuencial | 3,9 ms | 5,2 ms |
| Posición + 5/5, API, secuencial | 2,9 ms | 4,5 ms |
| Mismas consultas con 32 en vuelo | ~32 ms | ~60 ms |
| Redis `ZREVRANK` | 0,26 ms | 0,49 ms |
| Mongo `countDocuments` indexado | 6,3 ms | 10,0 ms |

Con 32 consultas en vuelo, la latencia corresponde a la espera en la cola de un único proceso Node, no a los motores. El costo por consulta es la fila secuencial.

## Pruebas

- Servicio y API con fakes: `gamingApp/test/unit/modules/leaderboards/leaderboards.test.ts` (top, regional, ventana y bordes, empates, errores, rebuild).
- P4 con leaderboard: `gamingApp/test/unit/modules/matchClosure/matchClosure.test.ts`. Cubre: publicación después del final scoreboard; nada se publica si falla `completeScoring`; publicación fallida reintentada sin reaplicar rating; un reintento tardío que no pisa una revisión nueva; modo o temporada sin ranking.
- Lua con Redis real: `gamingApp/test/integration/redisLeaderboardAdapter.test.ts` (`REDIS_URL`).
- Pipeline de Mongo contra los validadores reales: `gamingApp/test/integration/mongoLeaderboardStandings.test.ts` (`MONGODB_URI`, requiere `infra/mongo/init.js` aplicado).

## Limitaciones conocidas

- **Cambio de región a mitad de temporada:** se refleja cuando el jugador cierra su próxima partida (el registro toma la región actual y el script lo mueve de tablero). `rebuild` no lo corrige, porque publica la región guardada en `seasonRatings`. Actualizar de inmediato desde `PATCH /players` queda pendiente: bastaría con actualizar los registros de la temporada activa de ese jugador (con `revision + 1`) y publicar solo esos.
- **Cuentas cerradas o sancionadas:** siguen en la tabla. P8 tendrá que quitarlas o recalcular con el mismo mecanismo de revisiones.
- **Catálogos:** se leen de Mongo en cada consulta (tres lecturas por `_id` en paralelo). Un caché en memoria con TTL bajaría la latencia si hiciera falta.
- **Reconstrucción:** recorre la colección sin índice sobre la ruta dinámica. Es una operación administrativa poco frecuente.
- **Temporadas cerradas:** su ZSET sigue en Redis. Archivarlas en Cassandra (o en Mongo) y liberar la memoria queda como trabajo opcional.

## Mapa de archivos

```text
gamingApp/src/api/modules/leaderboards/
  business/models/                   tablero, posiciones, respuestas y errores
  business/ports/                    ranking (Redis) y directorio (Mongo)
  business/services/                 top, posición, rebuild
  infrastructure/adapters/           Redis (ZSET + Lua) y Mongo (catálogos, perfiles, registros por temporada)
  infrastructure/scripts/            top, around, publish y remove en Lua
  presentation/                      schema Zod, controller y router
gamingApp/src/api/modules/matchClosure/   paso de publicación en el scoring de P4
gamingApp/src/composition/leaderboardsComposition.ts
infra/mongo/init.js                   validador de players.seasonRatings (schema v6)
scripts/demo-problem-5.mjs            carga, verificación, latencia y fallas
docs/problema5.md                     este análisis
```

## Qué asumen los problemas siguientes

- **P6 (historial y estadísticas):** `seasonRatings` solo guarda el último valor de cada temporada. La evolución del rating partida a partida sale de `matches.finalScoreboard` (`mmrBefore`/`mmrAfter`) o de la tabla de historial que diseñe P6.
- **P8 (sanción con reversión):**
  - Al revertir rating tiene que actualizar `ratings` y `seasonRatings` en Mongo con `revision + 1`, y recién después publicar con `RedisLeaderboardAdapter.publish`: Mongo primero, Redis al final, como en P4.
  - Conviene que publique a todos los afectados de una temporada y modo en una sola llamada, para que el tablero no muestre una reversión a medias. Cada invocación del script es atómica hasta 500 registros.
  - Para quitar al sancionado usa `remove`.
  - La consulta "perfil con posición en leaderboards" puede reutilizar `LeaderboardService.position` por modo.
- **P7 (comportamiento irregular):** no depende del leaderboard.
- **Archivo en Cassandra (opcional):** una tabla `final_leaderboard_by_scope ((season, mode, scope), position)` cargada desde el ZSET al cerrar la temporada, con `position` como clave de clustering.
- Cualquier cambio en los scripts Lua debe reflejarse en `InMemoryLeaderboardRanking` (orden por MMR descendente y desempate por `playerId` descendente).

## Preguntas contrafactuales (para el informe)

Hace falta la **posición de un elemento dentro de un orden que cambia con cada partida**. El sorted set de Redis es un skiplist que guarda cuántos elementos saltea cada enlace, así que `ZREVRANK` y `ZADD` cuestan O(log N). Mongo, PostgreSQL y Neo4j ordenan con índices B-tree: devuelven el top-K rápido, pero para saber cuántos hay por encima de un jugador tienen que recorrer el índice hasta él (O(posición)). Cassandra no permite modificar la clave de clustering por la que ordena.

| Motor | Top 100 | Vecinos | Posición | Actualizar por partida | Veredicto |
|---|---|---|---|---|---|
| **Redis ZSET** | O(log N + 100) | O(log N + 10) | **O(log N)** | `ZADD` O(log N), idempotente | ✅ ranking vivo |
| MongoDB | índice | índice | O(posición) con `countDocuments` | B-tree | ✅ rating y perfil; ❌ como ranking |
| Cassandra | una partición | requiere leer el MMR antes | ❌ no existe | `DELETE` + `INSERT`, tombstones, partición caliente | ❌ ranking vivo; 🟡 temporadas cerradas |
| Neo4j | índice de rango | índice | O(posición) | ok | ❌ no hay relaciones que recorrer (es para P7) |
| PostgreSQL | índice | índice | `RANK()` O(N log N) o `COUNT` O(posición) | ok | ❌ motor extra sin justificación |

- **¿Y si el ranking viviera en MongoDB?** `countDocuments({mmr: {$gt: x}})` recorre el índice hasta la posición del jugador. `$setWindowFields` + `$rank` recalcula toda la partición en cada consulta. Precalcular posiciones con `$merge` deja la tabla desactualizada, y P4 exige que refleje el resultado "de inmediato". Además, la posición y los vecinos serían dos lecturas sin snapshot común. Medición local con 50.000 jugadores: `ZREVRANK` p50 0,26 ms contra `countDocuments` indexado p50 6,3 ms (~24×). El costo de Mongo crece con la posición.
- **¿Y si viviera en Cassandra?** Que las consultas sean fijas es necesario pero no suficiente: Cassandra rinde con datos que se escriben una vez. Con `PRIMARY KEY ((season, mode, scope), mmr, player_id)`, cada partida obliga a borrar e insertar con lectura previa, lo que deja tombstones en una única partición caliente. No existe una operación de posición, y los contadores por rango no son idempotentes. Queda **pendiente de evaluar** solo para archivar temporadas cerradas, que son inmutables.
- **¿Y si viviera en Neo4j?** Un leaderboard es una lista ordenada de pares (jugador, número), sin relaciones. Con índice de rango tiene el mismo problema de conteo que Mongo y ninguna ventaja: sería un motor forzado.
- **¿Y en PostgreSQL (opcional)?** Tendría el mismo costo de posición que Mongo, y la consigna solo acepta un relacional para un proceso que lo justifique explícitamente.
