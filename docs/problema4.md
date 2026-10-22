# Problema 4 — Cierre de una partida y puntuación eventual

## Consigna adoptada

Cuando el servidor de juego informa que una partida terminó, el sistema debe:

1. dejar de aceptar eventos para la partida;
2. conservar en Cassandra el hecho durable `match_finished`;
3. marcar la partida como terminada;
4. liberar a todos sus jugadores para que puedan volver a encolarse;
5. eliminar el estado vivo de Redis;
6. reconstruir desde Cassandra el marcador autoritativo;
7. guardar el resultado final y aplicar el cambio de rating.

El cierre y la disponibilidad de los jugadores tienen prioridad sobre el cálculo de puntos. Por eso el ciclo de vida de la partida y el estado del scoring se modelan por separado. El scoring puede quedar pendiente o fallar sin reabrir la partida ni bloquear jugadores.

La consigna textual original de P4 no estaba versionada en el repositorio. Este documento registra el análisis y las decisiones acordadas para que el comportamiento implementado sea explícito y revisable.

## Supuesto que reemplaza una secuencia por evento

Para mantener el TP acotado no se agregó un número de secuencia al esquema de eventos. El contrato con el servidor de juego es:

- espera la confirmación de todos los eventos anteriores;
- luego envía `finish`;
- una vez aceptado el cierre no envía más eventos.

`eventId`, `closureId` y `tsMs` deben repetirse sin cambios en cada reintento. En un sistema real con productores concurrentes convendría agregar una secuencia monotónica por partida y hacer que `match_finished` declare la última secuencia esperada.

## Motores y responsabilidades

| Motor | Responsabilidad |
|---|---|
| **Redis** | Puerta de admisión de eventos, estado vivo y liberación atómica de jugadores. |
| **Cassandra** | Bitácora inmutable y fuente de verdad de los hechos, incluido `match_finished`. |
| **MongoDB** | Máquina de estados durable, snapshot final de la partida y rating vigente de jugadores. |

Redis es la proyección rápida durante la partida, pero no decide el resultado final. Puede faltar en Redis un evento que sí quedó durable en Cassandra; por eso P4 reconstruye el marcador leyendo Cassandra.

## Dos máquinas de estado

### Ciclo de vida de la partida

```text
in_progress ──finish──> closing ──jugadores liberados──> closed
     │
     └─────────────> voided (reservado para P8)
```

- `in_progress`: P3 acepta eventos.
- `closing`: la puerta está cerrada; la saga de cierre está en progreso.
- `closed`: los jugadores están libres y el estado vivo fue retirado.
- `voided`: reservado para anulaciones posteriores.

### Estado de puntuación

```text
not_started → pending → calculating → applied
                            │
                            └────────> failed → calculating (reintento)
```

Una partida puede estar correctamente `closed` y tener `scoringStatus=failed`. No son estados contradictorios: terminó el juego y los jugadores están libres, pero falta una proyección administrativa.

## API

```http
POST /matches/:matchId/finish
```

```json
{
  "closureId": "uuid",
  "eventId": "uuid",
  "reason": "normal",
  "tsMs": 1760000099999,
  "results": [
    { "playerId": "uuid-a", "result": "win" },
    { "playerId": "uuid-b", "result": "loss" }
  ]
}
```

`reason`: `normal | forfeit | administrative`. Cada participante debe aparecer exactamente una vez. Los resultados válidos son todos `draw`, o una partición sin superposición entre `win` y `loss`.

El servidor de juego declara ganadores y perdedores porque P2 todavía no asigna equipos y las reglas cambian según el modo. P4 reconstruye las estadísticas desde Cassandra, pero no intenta deducir equipos que nunca fueron modelados.

Respuesta cuando el scoring terminó en la misma llamada:

```http
200 OK
```

```json
{
  "matchId": "uuid",
  "closureId": "uuid",
  "status": "closed",
  "scoringStatus": "applied",
  "playersReleased": true
}
```

Si el cálculo falla después de liberar, el cierre sigue siendo exitoso:

```http
202 Accepted
```

con `scoringStatus=failed`. Repetir el mismo request reintenta únicamente el trabajo pendiente y no vuelve a aplicar ratings.

## Flujo y punto de no retorno

### Fase de preparación — compensable

1. **Mongo read**: la partida existe; se validan estado, ids idempotentes y participantes.
2. **Redis beginClosing**: Lua cambia `in_progress → closing` solo si corresponde y guarda `closureId`.
3. **Mongo prepare**: compare-and-set `in_progress → closing`; guarda `closureId`, `eventId`, `tsMs`, razón y resultados declarados.

Si falla Mongo después de Redis, se revierte Redis a `in_progress`, condicionado por el mismo `closureId`.

### Commit irreversible

4. **Cassandra appendFinished**: inserta `match_finished` en `events_by_match`.

Este evento es el punto de no retorno. Antes se puede compensar hacia atrás; después solo se completa hacia adelante. Un log inmutable no borra hechos, y reabrir después de liberar jugadores sería inseguro porque alguno podría haberse encolado o unido a otra partida.

La falla inyectada ocurre antes de tocar Cassandra y sí se compensa. Un error real del driver puede ser ambiguo —Cassandra pudo escribir y perderse la respuesta—, por lo que se conserva `closing` y se exige reintentar las mismas claves idempotentes.

### Finalización — solo recuperación hacia adelante

5. **Redis release**: un Lua atómico verifica `status=closing` y `closureId`, libera `active_match` de todos los jugadores que todavía apuntan a esta partida, y borra la partida viva, marcador y set de aplicados.
6. **Mongo markClosed**: cambia a `status=closed`, `scoringStatus=pending`.

El script deja durante 24 horas `match:{matchId}:closure` con `status=released`. Si Redis ejecutó el script pero se perdió la respuesta, un reintento devuelve `ALREADY_RELEASED` y no toca un `active_match` nuevo.

### Scoring eventual

7. Mongo cambia `pending|failed → calculating` e incrementa `scoringAttempts`.
8. Cassandra se lee en páginas de 500 y se reducen solo los eventos de juego.
9. Se aplica rating por jugador, idempotente por `matchId`. Si la partida cuenta para una temporada (modo `ranked` y temporada activa que contiene `createdAt`), el mismo update escribe el standing `seasonRatings.<season>.<mode>` (ver P5).
10. Mongo guarda `finalScoreboard` y cambia a `scoringStatus=applied`; ante un fallo registra `failed` y `scoringLastError`.
11. Redis publica los standings de la partida en el leaderboard (un script Lua por partida) y Mongo marca `leaderboard.status=published|not_ranked`. Es el último paso: una falla deja el leaderboard atrasado (`leaderboardStatus=pending`, `202`), nunca adelantado respecto del rating o del historial. Ver [problema5.md](problema5.md).

No se implementa un worker ni outbox en este punto. El propio `POST finish`, repetido con los mismos ids, retoma un cierre o scoring incompleto. `scoringStatus` es un checkpoint durable que un worker futuro podrá consultar.

## Por qué el rollback termina antes de Cassandra

No es seguro prometer rollback hasta el paso 6. Contraejemplo:

```text
Redis libera al jugador A
       ↓
A vuelve a encolarse
       ↓
falla markClosed en Mongo
       ↓
un rollback intenta devolver A a la partida anterior
```

El jugador quedaría en dos estados incompatibles. La liberación es observable por otros procesos; después de ella solo se debe completar Mongo. Además, `match_finished` ya puede haber sido leído por consumidores. La separación prepare/commit/finalize hace explícita esta frontera.

## Scripts Redis

### `beginClosingScript`

- reconoce el marcador `released` de un reintento;
- acepta únicamente `status=in_progress`;
- guarda `status=closing` y `closureId` en un solo paso;
- el mismo `closureId` devuelve `REPLAYED`;
- otro estado o cierre devuelve conflicto.

P3 fue endurecido: `applyEventScript` ahora exige `match:{id}.status == in_progress`; la mera existencia de la clave ya no alcanza.

### `releaseMatchScript`

Antes de escribir valida toda la operación. Un `active_match` ausente se tolera; uno que apunta a otra partida produce conflicto. Después:

```text
DEL player:{id}:active_match   solo si su valor es matchId
DEL match:{matchId}
DEL match:{matchId}:scoreboard
DEL match:{matchId}:applied
HSET match:{matchId}:closure closureId ... status released
EXPIRE match:{matchId}:closure 86400
```

Lua hace indivisible la liberación y evita que una falla deje a una parte del grupo bloqueada.

## Evento durable de finalización

Se reutiliza `gaming.events_by_match`:

```text
match_id   = matchId
ts         = tsMs
event_id   = eventId
event_type = match_finished
player_id  = unset
detail     = {closureId, reason, results}
points     = 0
```

La clave primaria `(match_id, ts, event_id)` vuelve idempotente el reintento siempre que `eventId` y `tsMs` sean estables. `player_id` se envía como `unset`: finalizar una partida no es una acción individual.

`GET /matches/:id/events` puede devolver este evento. `reconcile` lo filtra y aplica a Redis únicamente eventos de juego.

## Cálculo autoritativo

P4 no usa el scoreboard de Redis para el resultado final. Reduce el log de Cassandra:

- `kill`: +1 kill al autor, `points` al score, +1 death al objetivo;
- `objective`: +1 objective y `points` al score;
- conexión/desconexión: no cambia el resultado competitivo;
- `match_finished`: marca el cierre, no puntúa y se excluye del reducer.

Los `points` quedaron fijados en P3 al registrar cada evento, de modo que un cambio futuro de reglas no altera partidas históricas.

## Rating simple e idempotente

Regla acordada para el TP:

| Resultado | Delta |
|---|---:|
| `win` | `+25` |
| `loss` | `-25` |
| `draw` | `0` |

Mongo suma el delta a `ratings.<mode>.mmr` y un partido jugado. Cada jugador mantiene `appliedRatingMatches`; la misma operación usa el filtro:

```text
_id = playerId AND appliedRatingMatches != matchId
```

y en una única actualización del documento (pipeline de agregación) suma el delta, agrega `matchId` a `appliedRatingMatches` y, si la partida cuenta para una temporada, copia el MMR resultante al standing de la temporada. Si el jugador todavía no tenía rating en el modo, parte del MMR con que P2 formó la partida (antes un `$inc` sobre un campo inexistente dejaba el MMR en el delta). Si una partida aplicó algunos jugadores y falló, el reintento omite los ya procesados y completa los restantes.

Los deltas fijos son conmutativos y toleran que partidas diferentes se procesen fuera de orden. Se acepta una consecuencia de la prioridad elegida: un jugador puede reencolarse con el MMR anterior mientras su scoring está pendiente. El rating nuevo aparecerá después; no se bloquea al jugador.

El snapshot final conserva `mmrBefore`, `ratingDelta` y `mmrAfter` calculados desde el MMR con que P2 formó la partida.

## Idempotencia

- `closureId`: identifica el workflow de cierre.
- `eventId + tsMs`: identifican la fila de Cassandra.
- Redis reconoce `closing`, `released` y el mismo `closureId`.
- Mongo transiciona con filtros por estado y `closure.id`.
- Rating se aplica una vez por `(matchId, playerId)`.
- Un cierre `closed/applied` devuelve el mismo resultado sin repetir escrituras.
- `failScoring` solo puede cambiar `calculating → failed`; si Mongo confirmó `applied` pero se perdió la respuesta, el manejo del error vuelve a leer el checkpoint y no degrada el estado.
- Reusar `closureId` con otro `eventId` o resultados distintos produce `409 MATCH_CLOSE_CONFLICT`.

## Fallas

| Falla | Estado conservado | Acción |
|---|---|---|
| Redis no puede pasar a `closing` | Sin cambio confirmado | `503 MATCH_CLOSE_UNAVAILABLE`; reintentar igual `closureId`. |
| Mongo prepare falla | Redis se compensa a `in_progress` | Reintentar cierre. |
| Falla inyectada antes de Cassandra | Mongo y Redis vuelven a `in_progress` | No hubo commit. |
| Error real/ambiguo de Cassandra | Queda `closing` | No reabrir; repetir mismo evento. |
| Redis release falla después del evento | Cassandra durable, Mongo/Redis `closing` | Reintentar hacia adelante. |
| Mongo markClosed falla tras liberar | Jugadores libres, Mongo `closing` | Reintentar; el marcador Redis `released` protege partidas nuevas. |
| Lectura Cassandra o rating falla | Partida `closed`, jugadores libres, scoring `failed` | `202`; repetir finish para reintentar scoring. |
| Complete scoring falla antes de confirmar | Ajustes parciales idempotentes | Reintentar; no duplica los aplicados. |
| Mongo confirma `applied` pero se pierde la respuesta | Permanece `applied` | La relectura devuelve éxito y nunca lo degrada a `failed`. |
| Publicación del leaderboard falla | Rating e historial aplicados, Redis sin cambios | `202` con `leaderboardStatus=pending`; repetir finish solo republica (o `POST /leaderboards/:mode/:season/rebuild`). |

## Inyección de fallas

Header `x-fail-db: <base>`: falla la primera escritura en esa base durante el cierre.

| Header | Falla | Resultado |
|---|---|---|
| `x-fail-db: redis` | pasar a `closing` | `500`; nada cambió. |
| `x-fail-db: mongo` | prepare en Mongo | `500`; Redis se compensa a `in_progress`. |
| `x-fail-db: cassandra` | evento `match_finished` | `500`; Mongo y Redis vuelven a `in_progress`. |

Los pasos posteriores al commit (release, scoring, publicación del leaderboard) no son la primera escritura de su base, así que se prueban en los tests unitarios (`matchClosure.test.ts`) haciendo fallar ese paso del doble en memoria.

## Pruebas

- Servicio/API con fakes: `test/unit/modules/matchClosure/matchClosure.test.ts`.
- Semántica real de Lua: `test/integration/redisMatchClosureAdapter.test.ts` (se omite sin `REDIS_URL`).
- P3 agrega una prueba que rechaza eventos en `closing`.

Casos cubiertos: cierre feliz, snapshot reconstruido desde eventos, compensación segura antes del commit, falla de release después del commit, reanudación hacia adelante, scoring fallido sin bloquear jugadores, rating idempotente, respuesta perdida después de confirmar `applied` y resultados inválidos.

## Limitaciones conocidas

- No existe worker periódico; el reintento explícito de `finish` recupera el workflow.
- El contrato sin secuencia depende de que el servidor de juego drene eventos antes de finalizar.
- `appliedRatingMatches` crece con la cantidad de partidas del jugador; para gran escala conviene una colección de ledger con transacción o compactación.
- El marcador de liberación Redis expira en 24 horas; Mongo sigue siendo el checkpoint durable.
- No hay autenticación del servidor de juego.
- Los resultados competitivos son declarados por el servidor porque P2 no modela equipos.
- Se acepta temporalmente matchmaking con MMR anterior mientras el scoring está pendiente.

## Mapa de archivos

```text
gamingApp/src/api/modules/matchClosure/
  business/models/                   estados, inputs, resultados y errores
  business/ports/                    contratos Mongo/Redis/Cassandra
  business/services/                 orquestación, frontera de commit y reducer
  infrastructure/adapters/           implementaciones de los tres motores
  infrastructure/scripts/            begin/rollback/release en Lua
  presentation/                      schema Zod, controller y router
gamingApp/src/composition/matchClosureComposition.ts
gamingApp/test/unit/modules/matchClosure/
gamingApp/test/integration/redisMatchClosureAdapter.test.ts
infra/mongo/init.js                   estado closing y guardas de rating
docs/problema4.md                     este análisis
```
