# Problema 2 — Formación de una partida

Consigna: el sistema agrupa jugadores de rating similar hasta completar la partida según el modo, crea la partida y retira a los jugadores de la cola. Si la espera supera cierto tiempo, se amplía el rango de rating. **Falla:** si un jugador abandona la cola durante la formación o falla la creación de la partida, los demás vuelven a la cola **conservando su antigüedad**. Tipo: **Escritura con falla y rollback**.

Requiere haber leído `problema1.md` (formato de la cola).

## Motores y responsabilidades

| Motor | Rol |
|---|---|
| **Redis** | Cola, reserva atómica de jugadores, diario de la formación (saga) y partida **viva** (`match:{id}`). |
| **MongoDB** | Configuración del modo (lectura) y registro **durable** de la partida (`matches`). |

No hay transacción entre motores: se resuelve con una **saga** con orden de escrituras, compensación por paso, idempotencia y registro de pasos.

## Identificadores

- `matchId` (UUID): lo genera `form()` con `randomUUID()`. Es `matches._id` (Mongo), sufijo de `match:{id}` y `mm:formation:{id}`, miembro de `mm:formations` y valor de `player:{id}:active_match`. Los problemas siguientes (P3, P4, historial en Cassandra, grafo en Neo4j) deben **reutilizarlo**.
- `playerId`, `ticketId`: ver `problema1.md`.

## Selección de jugadores (solo lecturas)

`MatchFormationService.selectPlayers` (`business/services/matchFormationService.ts`):

1. **Ancla** = el ticket más antiguo del ZSET `wait` (`findOldestTicket`).
2. **Rango** (`acceptedRatingRange`):
   `rango = min(maxRatingRange, initialRatingRange + ratingRangeStep × floor(espera / expandEverySeconds))`
   con `espera = ahora − ancla.enqueuedAt` (solo cuenta la espera del ancla). Parámetros en `game_modes.matchmaking` (Mongo), leídos por `findFormationMode`. Ejemplos: `ranked_1v1` ±50, +50 cada 15 s, tope ±400; `ranked_5v5` ±100/+50/20 s/±500; `casual_5v5` ±200/+100/10 s/±1000; `battle_royale` ±150/+75/15 s/±600.
3. **Candidatos** = `ZRANGEBYSCORE` en `rating` dentro de `[mmr_ancla − rango, mmr_ancla + rango]` (límite de escaneo 500) → se leen sus tickets en un pipeline.
4. Orden por antigüedad (desempate por `playerId`), el ancla siempre primero, se toman hasta `maxPlayers`.
5. Si hay menos de `minPlayers` → resultado `not_enough_players` (no se escribió nada).

**Limitaciones conocidas:** la ventana se mide contra el ancla, no entre todos los candidatos; **no se asignan equipos** (solo se reúne el grupo; en 1v1 no hace falta, en modos 5v5 queda pendiente repartir en equipos balanceados por mmr); si el ancla no puede formar partida, no se prueba con otro ancla.

## La saga

`MatchFormationService.form` / `completeFormation`. Orden de escrituras, compensaciones y por qué:

| Paso | Motor | Acción | Compensación | Notas |
|---|---|---|---|---|
| **A. reserve** | Redis | `reserveFormationScript` (Lua, atómico, todo o nada) | `restoreFormationScript` | Va primero: es el punto de contención (dos formaciones no pueden tomar al mismo jugador) y es barato de deshacer. |
| **B. createMatch** | Mongo | `matches.updateOne({_id: matchId}, {$setOnInsert: …}, {upsert: true})` | `deleteOne({_id: matchId, status: "in_progress"})` | Idempotente por `_id`. |
| **C. commit** | Redis | `commitFormationScript` (Lua) | — (es el último paso) | Idempotente si ya está `committed`. |

### Paso A — `reserveFormationScript`

KEYS: formación, índice de formaciones, ZSET rating, ZSET wait, N tickets, N `active_match`. Verifica que cada ticket siga existiendo **con el mismo `ticketId`**.
- Si falta alguno → `MISSING` + ids, **sin escribir nada**. El servicio recalcula (hasta 3 intentos; luego `FormationContendedError` → 409).
- Si todos están: crea `mm:formation:{matchId}` con `status=reserved`, `createdAt` y `tickets` (JSON, copia inmutable de los tickets), saca a los jugadores de ambas ZSET, borra los tickets, setea `active_match = matchId` (evita que se reencolen durante la formación) y agrega la formación a `mm:formations` (ZSET por fecha).

### Paso C — `commitFormationScript`

Si el estado es `committed` devuelve OK (idempotente); si no es `reserved` → error. Si existe algún campo `abandoned:*` devuelve `ABANDONED`. Si no: crea `match:{matchId}` (HASH: `matchId, mode, region, status=in_progress, startedAt, players` en CSV), marca la formación `committed` y la saca de `mm:formations`.

### Compensación

`MatchFormationService.compensate` (orden inverso):
1. Mongo `delete(matchId)`.
2. Redis `restoreFormation`: lee el snapshot y ejecuta `restoreFormationScript`. Para cada jugador **que no abandonó** y sin ticket nuevo, recrea el HASH y los `ZADD` en ambas ZSET con el **`mmr` y `enqueuedAt` originales** (conserva la antigüedad), y borra `active_match` solo si vale `matchId`. Borra `match:{id}`, marca `rolled_back`, saca del índice. Si ya estaba `rolled_back` no hace nada; si estaba `committed` no toca nada.

### Abandono durante la formación

`RedisQueueAdapter.leave`: si el jugador no tiene ticket, mira su `active_match`; si apunta a una formación `reserved`, `abandonFormationScript` registra `abandoned:{playerId}` en la formación y borra su `active_match`. Efectos: `commit` devuelve `ABANDONED` → el servicio compensa y responde `rolled_back` / `player_left` con la lista `restored` (todos menos el que se fue). Un abandono *antes* de reservar se resuelve solo por el `MISSING` del paso A.

### Registro de pasos y recuperación

El HASH `mm:formation:{matchId}` es el diario: `reserved → committed | rolled_back`. Si el proceso muere o la compensación falla, la formación queda `reserved` y en `mm:formations`. `recoverStaleFormations(olderThanMs = 30 000)` compensa todas las que superan esa edad. Es idempotente y seguro frente a una request lenta que despierta tarde (su commit falla porque el estado ya es `rolled_back`, y vuelve a compensar sin efecto).

**Si falla cada paso:** A → nada escrito. B → se restaura Redis. C → se borra Mongo y se restaura Redis. Compensación fallida → queda `reserved`, la repara `recover`.

## Modelo de datos nuevo

**Redis** (claves en `storageKeys.ts`): `mm:formation:{matchId}` (HASH), `mm:formations` (ZSET), `match:{matchId}` (HASH). Tabla completa en `infra/redis/README.md`.

**Mongo** — colección `matches` (validador en `infra/mongo/init.js`, `schema_metadata` v4):
`_id=matchId, mode, region, status (in_progress|closed|voided), ratingRange, createdAt, players[{playerId, mmr, enqueuedAt}]`. Índices: `{status, createdAt}` y `{players.playerId, createdAt:-1}`. Los estados `closed`/`voided` los usarán P4 y P8.

**Desnormalización:** el snapshot de tickets dentro de la formación (Redis) y `players[]` dentro de `matches` (Mongo) duplican datos del ticket. Responsable: `MatchFormationService`. Se usan solo para compensar y como registro inicial de la partida.

## API

`presentation/routers/matchmakingRouter.ts` (el segundo parámetro, `MatchFormationController`, habilita las rutas), `controllers/matchFormationController.ts`, `schemas/formationSchema.ts`.

| Ruta | Respuesta |
|---|---|
| `POST /matchmaking/matches/form` `{mode, region}` | `201` `{status:"formed", matchId, players, ratingRange}` · `200` `{status:"not_enough_players", queued, required, ratingRange}` · `200` `{status:"rolled_back", reason:"player_left", matchId, restored}` · `409 FORMATION_CONTENDED` |
| `POST /matchmaking/matches/recover` `{olderThanMs?}` | `{recovered:[{matchId, restored}]}` |

No hay worker periódico: la formación se dispara por endpoint (se puede agregar un `setInterval` que llame a `form` por cada modo/región).

## Inyección de fallas

- Header `x-fail-at: <paso>` con: `matchmaking.reserve`, `matchmaking.createMatch`, `matchmaking.commit`, `matchmaking.restore` (también `matchmaking.deleteMatch`, `findFormationMode`, `findOldestTicket`, `findCandidates`). Un solo paso por pedido, así la compensación puede ejecutarse.
- Header `x-pause-after-reserve-ms: <ms>` (máx. 30 000): frena la saga entre la reserva y la creación; sirve para simular un abandono o una request lenta. Se guarda en `requestContext.pauseAfterReserveMs`.

## Tests y demo

- Unitarios: `gamingApp/test/unit/modules/matchmaking/matchFormation.test.ts` (rango, formación, falla en createMatch y commit, abandono, recover idempotente). Usan `InMemoryMatchmakingQueue` (que reimplementa la semántica de los scripts Lua) e `InMemoryMatchRepository` en `test/support/inMemory/`. **Si se cambia un script Lua, actualizar el fake equivalente.**
- Demo contra Docker: `scripts/demo-problem-2.sh`. Seis escenarios con verificación de Redis y Mongo: caso feliz, ampliación de rango, falla en Mongo, falla en commit, abandono durante la formación, y recuperación de una formación interrumpida. Usa la cola `NA` de `ranked_1v1` con jugadores descartables. Nota: en Git Bash de Windows usar `127.0.0.1`, no `localhost`.
- Los scripts Lua no tienen test de integración propio; los cubre el demo.

## Mapa de archivos

```
gamingApp/src/api/modules/matchmaking/
  business/models/matchFormation.ts            tipos (FormationMode, MatchRecord, outcomes, FormationResult)
  business/models/matchmakingErrors.ts         + FormationContendedError
  business/ports/matchmakingPorts.ts           + métodos de formación, MatchRepositoryPort
  business/services/matchFormationService.ts   saga + acceptedRatingRange
  infrastructure/scripts/matchmakingScripts.ts reserve/commit/restore/abandon (Lua)
  infrastructure/adapters/redisQueueAdapter.ts operaciones de formación y leave extendido
  infrastructure/adapters/mongoMatchAdapter.ts create / delete en `matches`
  infrastructure/adapters/mongoEligibilityAdapter.ts  + findFormationMode
  presentation/controllers/matchFormationController.ts, schemas/formationSchema.ts
gamingApp/src/composition/matchmakingComposition.ts   cableado
gamingApp/src/api/middlewares/faultInjectionMiddleware.ts  x-fail-at y x-pause-after-reserve-ms
infra/mongo/init.js   colección `matches`
infra/redis/README.md claves y saga
scripts/demo-problem-2.sh
```

## Qué asumen los problemas siguientes

- **P3 (eventos):** ya implementado (`problema3.md`). Lee `match:{matchId}` (HASH vivo, `players` en CSV) para validar que la partida está viva y que los jugadores pertenecen a ella; si `match:{matchId}` desaparece, deja de aceptar eventos.
- **P4 (cierre):** debe borrar `active_match` de cada jugador, borrar o archivar `match:{matchId}`, y pasar `matches.status` a `closed`. Debe seguir el mismo patrón de saga (orden, compensación, idempotencia, diario).
- **P8:** `status: "voided"` en `matches` está reservado para partidas anuladas.
- Cualquier cambio en el formato del ticket o de la formación afecta a `restoreFormationScript`, que reconstruye los tickets desde el snapshot.
