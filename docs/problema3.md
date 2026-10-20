# Problema 3 — Eventos durante la partida

Consigna: durante una partida se reciben eventos (eliminaciones, objetivos, desconexiones) con precisión de milisegundos. El **marcador en vivo** debe poder consultarse al instante y **todos los eventos deben conservarse**. Hay que simular al menos **100 partidas simultáneas**. Tipo: **Escritura** (sin rollback obligatorio; igual hay dos motores, así que se documenta la estrategia ante fallas).

Requiere haber leído `problema2.md` (de ahí sale `match:{matchId}` y el `matchId`).

## Motores y responsabilidades

| Motor | Rol |
|---|---|
| **Cassandra** | **Bitácora durable** e inmutable de todos los eventos (`gaming.events_by_match`). Fuente de verdad de *qué pasó*. |
| **Redis** | **Marcador en vivo** (`match:{id}:scoreboard`) y registro de eventos ya aplicados (`match:{id}:applied`). Fuente de verdad del marcador *mientras la partida está viva*. |
| Mongo | No interviene (el registro durable de la partida ya lo creó P2). |

Redis **no es una caché de Cassandra**: Cassandra nunca guarda el marcador, y Redis nunca guarda el historial. El marcador es estado vivo con ciclo de vida propio (nace en P2, se actualiza acá, se consume/archiva en P4). Esto importa porque la consigna (sección 2) no acepta un motor que solo replica datos de otro para acelerar lecturas.

El marcador es **derivado** del log (se puede reconstruir con `reconcile`), pero su lectura "al instante" es una responsabilidad que el log no puede cumplir (agregar la partición en cada lectura no es "instantáneo"). P4 reconstruye su resultado final directamente desde Cassandra y no confía en que esta proyección esté completa.

## Identificadores

- `matchId`: el UUID que generó P2. Es `match_id` en Cassandra y sufijo de las claves Redis. **No se genera acá.**
- `eventId` (UUID): lo **elige quien produce el evento** (el servidor de juego). Es la clave de idempotencia. Va en la clave primaria de Cassandra y en el set de eventos aplicados de Redis.
- `playerId`: el de Mongo/P1. Debe pertenecer a la partida (se valida contra `match:{id}.players`).

## Flujo y orden de escrituras

`MatchEventService.record` (`business/services/matchEventService.ts`), invocado por `POST /matches/:matchId/events`:

| Paso | Motor | Acción | Notas |
|---|---|---|---|
| 0. validar | Redis | `HGETALL match:{id}`: la partida existe y está `in_progress`; `playerId` y `targetPlayerId` están en `players` | Solo lectura. Si no: `404 MATCH_NOT_LIVE` / `422 PLAYER_NOT_IN_MATCH`. No se escribe nada. |
| 1. append | Cassandra | `INSERT` en `events_by_match` | Idempotente: misma `(match_id, ts, event_id)` = misma fila. |
| 2. apply | Redis | `applyEventScript` (Lua, atómico) | Idempotente por `eventId`. |

**Por qué Cassandra primero.** Si el paso 2 falla, el evento ya está a salvo en el log y el marcador se arregla reintentando el mismo evento o con `reconcile`. Al revés (Redis primero), un fallo del paso 2 dejaría un marcador con puntos que ningún evento del log explica, y no habría de dónde reconstruirlo.

**Por qué no hay compensación (rollback).** No hace falta deshacer el paso 1: un evento en el log es un hecho que ocurrió, no una operación a revertir. Lo que se repara es el marcador, hacia adelante. Por eso es "Escritura" y no "Escritura con falla y rollback". (P4 y P8 sí tienen que compensar; ver abajo.)

### Qué pasa si falla cada paso

| Falla | Cassandra | Redis | Cómo se arregla |
|---|---|---|---|
| Paso 0 (Redis caído) | — | — | `503 STORAGE_ERROR engine=redis`. Reintentar. |
| Paso 1 (Cassandra caído / `x-fail-at: matchEvents.appendEvent`) | sin cambios | sin cambios | `503` / `500`. Reintentar el mismo evento. |
| Paso 2 (`x-fail-at: matchEvents.applyScoreboard`, o Redis cae entre pasos) | **tiene el evento** | no lo aplicó | Reintentar el mismo `eventId` (Cassandra sobrescribe la misma fila, Redis aplica) **o** `POST …/scoreboard/reconcile`. |
| Respuesta HTTP perdida (el cliente reintenta) | sobrescribe la misma fila | el script responde `DUPLICATE` | Responde `200 duplicate`. Nada se cuenta dos veces. |
| La partida se cierra entre paso 0 y 2 | tiene el evento | el script responde `NOT_LIVE` | `404 MATCH_NOT_LIVE`. El evento queda en el log pero no puntúa (ver limitaciones). |

Probado en vivo: con `docker stop gaming-cassandra` el POST responde `503 {"error":"STORAGE_ERROR","engine":"cassandra","step":"matchEvents.appendEvent"}`, el marcador queda intacto y sigue legible; al volver Cassandra el driver reconecta solo y el reintento del mismo `eventId` responde `201 recorded`.

## Idempotencia del marcador (`HINCRBY` no lo es)

`HINCRBY` suma cada vez que se ejecuta. Con un reintento (se perdió la respuesta) el contador se duplicaría. Por eso el paso 2 es **un solo script Lua** (`infrastructure/scripts/matchEventScripts.ts`) que hace `SADD match:{id}:applied <eventId>` y, solo si el id era nuevo, suma. Un script Lua se ejecuta sin que Redis intercale otros comandos, así que "verificar y sumar" no se puede partir.

No se usó `SET NX` + `HINCRBY` por separado: si el proceso muere entre los dos, el evento queda marcado como aplicado pero nunca se sumó, y los reintentos lo saltean para siempre.

El mismo script primero exige `match:{id}.status = in_progress`: desde que P4 pasa a `closing`, devuelve `NOT_LIVE` y **no** recrea claves huérfanas.

### Campos del marcador (HASH `match:{matchId}:scoreboard`)

| Campo | Significado |
|---|---|
| `events` | Cantidad de eventos aplicados. |
| `lastEventTs` | Mayor `tsMs` aplicado. |
| `{playerId}:kills` / `:deaths` / `:objectives` / `:score` | Contadores (conmutativos: el orden de llegada no importa). |
| `{playerId}:connected` (`1`/`0`) y `:connectionTs` | Estado de conexión. Se queda con el valor del `tsMs` más nuevo; **a igual ms gana `disconnect`**. Así un `disconnect` que llega tarde no pisa un `reconnect` posterior. |

Reglas de puntaje: `kill` = +1 `kills` y +`killPoints` (1) `score` al autor, +1 `deaths` a la víctima; `objective` = +1 `objectives` y +`points` (1–1000, por defecto 1) a `score`. `disconnect`/`reconnect` no puntúan. Los puntos se **fijan al registrar** y se guardan en el log (`points`), así un `reconcile` posterior da el mismo resultado aunque cambie la regla.

## Reconcile

`POST /matches/:matchId/scoreboard/reconcile` (`MatchEventService.reconcile`): lee **todo el log** de la partida (páginas de 500) y lo pasa por el mismo script. Los eventos ya aplicados se saltean, así que:

- es **seguro mientras siguen llegando eventos**;
- rellena los huecos que dejó un paso 2 fallido que nadie reintentó;
- reconstruye el marcador entero si se perdieron las claves `:scoreboard` y `:applied`.

Devuelve `{read, repaired}`. **Límite:** exige que exista `match:{id}` (el HASH que publica P2). Si Redis perdiera *todo*, esa clave también se pierde y hay que recrearla desde Mongo `matches` antes (no implementado; mitigado por `appendonly yes` en `docker-compose.yml`).

## Modelo de datos

### Cassandra — `gaming.events_by_match` (`infra/cassandra/init.cql`)

```cql
PRIMARY KEY ((match_id), ts, event_id)  -- CLUSTERING ORDER BY (ts ASC, event_id ASC)
match_id uuid, ts timestamp, event_id uuid, event_type text,
player_id uuid, target_player_id uuid, detail text (JSON), points int
```

- **Partición = partida**: toda la bitácora de una partida está junta y ordenada por tiempo; una partida tiene una cantidad acotada de eventos, así que la partición no crece sin límite.
- **`ts` (timestamp, ms)** da la precisión pedida. **`event_id`** desempata eventos del mismo milisegundo (la simulación los genera a propósito) y hace idempotente la escritura.
- Las columnas ausentes se envían como `unset`, no `null`, para no generar tombstones.
- Consistencia `LOCAL_QUORUM` (`cassandraConnection.ts`); con `replication_factor 1` equivale a `ONE`.
- Sin TTL: "todos los eventos deben conservarse".

**Consultas que justifican la tabla** (cada tabla de Cassandra debe poder apuntar a su consulta):

| Consulta | Quién la usa |
|---|---|
| Todos los eventos de una partida, en orden | `GET /matches/:id/events`; `reconcile`; auditoría; P6/P7 |
| Eventos de una partida en un rango de tiempo | `GET /matches/:id/events?fromTsMs=&toTsMs=` |

No existe consulta "eventos por jugador": si P7 la necesita, va **otra tabla** con otra partición (`events_by_player`), mantenida por el mismo servicio (desnormalización deliberada que hay que documentar).

### Redis (claves en `shared/storageKeys.ts`, tabla en `infra/redis/README.md`)

`match:{matchId}:scoreboard` (HASH), `match:{matchId}:applied` (SET de `eventId`). Ninguna tiene TTL: **P4 debe borrarlas** al cerrar.

### Desnormalización

- `points` se duplica en el log y en el marcador (el marcador es derivado). Responsable: `MatchEventService`.
- La lista de jugadores sale de `match:{id}.players` (CSV publicado por P2), duplicado de `matches.players` en Mongo.

## API

`presentation/routers/matchEventRouter.ts`, montado en `/matches` (`composition/matchEventsComposition.ts`).

| Ruta | Respuesta |
|---|---|
| `POST /matches/:matchId/events` | `201 {eventId, status:"recorded"}` · `200 {…, status:"duplicate"}` · `400` validación · `404 MATCH_NOT_LIVE` · `422 PLAYER_NOT_IN_MATCH` · `503 STORAGE_ERROR` |
| `GET /matches/:matchId/events?fromTsMs&toTsMs&limit&pageState` | `{events:[…], nextPageState}` (orden temporal; `limit` 1–1000, por defecto 100; paginar con `pageState`) |
| `GET /matches/:matchId/scoreboard` | `{matchId, mode, region, status, startedAt, eventCount, lastEventTsMs, players:[{playerId, kills, deaths, objectives, score, connected}]}` ordenado por puntaje. Incluye a todos los jugadores aunque no tengan eventos. `404` si la partida no está viva. |
| `POST /matches/:matchId/scoreboard/reconcile` | `{read, repaired}` |

Cuerpo del `POST` de eventos (`schemas/matchEventSchema.ts`):

```json
{ "eventId": "uuid", "type": "kill|objective|disconnect|reconnect",
  "playerId": "uuid", "targetPlayerId": "uuid (solo kill, obligatorio)",
  "points": 1, "tsMs": 1760000000123, "detail": { "weapon": "rifle" } }
```

`eventId` **y** `tsMs` son obligatorios y deben repetirse idénticos en un reintento: si un reintento cambiara `tsMs`, sería otra fila del log. `points` solo en `objective`; `detail` hasta 2 KB de JSON.

## Inyección de fallas

Header `x-fail-at: <paso>`: `matchEvents.findLiveMatch`, `matchEvents.appendEvent`, `matchEvents.applyScoreboard`, `matchEvents.listEvents`, `matchEvents.findScoreboard`. Para una falla real: `docker stop gaming-cassandra` (o `gaming-redis`) durante la carga.

## Simulación y resultados

`scripts/demo-problem-3.mjs` (Node ≥ 18, sin dependencias; Git Bash, PowerShell o cmd):

```bash
docker compose up -d --build         # mongodb, redis, cassandra, gaming-app
./scripts/initialize-infrastructure.sh   # (o .ps1) aplica el esquema de Cassandra
node scripts/demo-problem-3.mjs
```

Variables: `APP_URL` (`http://127.0.0.1:3001`), `MATCHES` (100), `EVENTS_PER_MATCH` (300), `CONCURRENCY` (64), `MODE`, `REGION`. Hace:

1. **Setup con el flujo real de P1 y P2**: registra `2·MATCHES` jugadores, los encola y forma las partidas (se reutiliza el `matchId` de P2).
2. **Carga**: eventos de todas las partidas intercalados, fuera de orden de timestamp, varios en el mismo ms, 5 % reenviados, mientras se consulta el marcador.
3. **Consistencia**: cada marcador debe ser igual a lo que suman los eventos enviados (recalculado en el script) y Cassandra debe tener cada evento exactamente una vez.
4. **Fallas**: antes del log, entre el log y el marcador, reintento, y reparación con `reconcile`.
5. Rechazos (partida no viva, jugador ajeno).

Medición de referencia (una PC, Docker Desktop, un solo proceso Node, 100 partidas × 300 eventos = 31 500 requests, 64 en vuelo): ~1 200 req/s, `POST` p50 ≈ 50 ms / p95 ≈ 78 ms (incluye cola del cliente), lectura de marcador bajo carga p50 ≈ 33 ms y sin carga ≈ 4 ms. 0 diferencias en marcadores y en el log. Son números indicativos, no un benchmark.

P4 cierra las partidas mediante `POST /matches/:matchId/finish`, libera jugadores y elimina las claves vivas. Ver `problema4.md`.

## Tests

- Unitarios: `gamingApp/test/unit/modules/matchEvents/matchEvents.test.ts` (servicio + API: idempotencia, falla en cada paso, reconcile, orden de conexión, paginación, validación). Usan `InMemoryEventLog` / `InMemoryLiveScoreboard` (`test/support/inMemory/inMemoryMatchEvents.ts`), que **reimplementan el script Lua: si se cambia el script, cambiar el fake**.
- Integración con motores reales: `test/integration/matchEvents.test.ts` (200 eventos × 3 envíos simultáneos, reconstrucción tras perder Redis, partida cerrada). Se saltea sin variables:

```bash
REDIS_URL=redis://127.0.0.1:6379 CASSANDRA_CONTACT_POINTS=127.0.0.1 pnpm test
```

## Configuración nueva

Variables de la app (`gamingApp/src/config.ts`, ejemplos en `gamingApp/.env.example` y en `docker-compose.yml`): `CASSANDRA_CONTACT_POINTS` (obligatoria, lista separada por comas), `CASSANDRA_PORT`, `CASSANDRA_LOCAL_DATACENTER` (`datacenter1`), `CASSANDRA_KEYSPACE` (`gaming`), `CASSANDRA_CONNECT_RETRIES`, `CASSANDRA_RETRY_DELAY_MS`. La app **exige que el keyspace exista** (`init.cql`): si se levanta antes de aplicar el esquema, reintenta y termina; `restart: unless-stopped` la vuelve a levantar. `/ready` ahora también consulta Cassandra. Nueva dependencia: `cassandra-driver`.

En Git Bash de Windows, `docker compose exec … -f /opt/gaming/init.cql` convierte la ruta: usar `MSYS_NO_PATHCONV=1` o el script `.ps1`.

## Mapa de archivos

```
gamingApp/src/api/modules/matchEvents/
  business/models/matchEvent.ts             tipos (MatchEvent, Scoreboard, resultados)
  business/models/matchEventErrors.ts       MatchNotLiveError, PlayerNotInMatchError
  business/ports/matchEventPorts.ts         MatchEventLogPort (Cassandra), LiveScoreboardPort (Redis)
  business/services/matchEventService.ts    record / listEvents / getScoreboard / reconcile
  infrastructure/scripts/matchEventScripts.ts   applyEventScript (Lua)
  infrastructure/adapters/cassandraEventLogAdapter.ts, redisScoreboardAdapter.ts
  infrastructure/mappers/eventRowMapper.ts, scoreboardMapper.ts
  presentation/controllers/matchEventController.ts, routers/matchEventRouter.ts, schemas/matchEventSchema.ts
gamingApp/src/infrastructure/cassandra/cassandraConnection.ts, baseCassandraAdapter.ts
gamingApp/src/composition/matchEventsComposition.ts   cableado (+ createContainer.ts, server.ts)
gamingApp/src/shared/storageKeys.ts       cassandraTables, redisKeys.matchScoreboard / matchAppliedEvents
gamingApp/src/api/errorHandler.ts         404 MATCH_NOT_LIVE, 422 PLAYER_NOT_IN_MATCH
infra/cassandra/init.cql                  events_by_match
scripts/demo-problem-3.mjs
```

## Limitaciones conocidas

- **Una lectura extra de Redis por evento** (paso 0). Se puede cachear la lista de jugadores por partida si hiciera falta más throughput.
- **Evento concurrente con el cierre**: si P4 cambia a `closing` entre el paso 0 y el 2, el evento puede quedar en el log pero no puntuar y la respuesta es `404`. P4 simplifica esta frontera con el contrato de que el servidor drena eventos antes de enviar `finish`; una solución productiva usaría secuencias.
- **`eventId` reusado con otro `tsMs`** (error del productor): Redis lo cuenta una vez, pero Cassandra guarda dos filas. No se detecta.
- `:applied` crece con la partida (36 B por evento) y no tiene TTL; P4 debe borrarlo.
- Redis ejecuta el script con `EVAL` (envía el texto cada vez). Se puede pasar a `EVALSHA`.
- No hay endpoint por lote, ni autenticación (el servidor de juego se asume confiable), ni worker periódico de `reconcile`.
- Los eventos de juego son los cuatro de la consigna y requieren `playerId`. P4 agrega el evento de ciclo de vida `match_finished`, sin jugador, directamente desde el flujo de cierre; el endpoint general de eventos no permite que un cliente lo fabrique.
- El `kill` no se valida contra el estado de conexión del autor ni de la víctima.

## Qué asumen los problemas siguientes

- **P4 (cierre):** implementado en `problema4.md`. Pasa la partida a `closing`, guarda `match_finished`, libera jugadores y elimina las claves vivas. El resultado final se reduce desde Cassandra; Redis no es autoritativo para el cierre.
- **P6 (historial/estadísticas):** `events_by_match` sirve para el detalle de una partida; la lista "últimas 50 partidas de un jugador" necesita su propia tabla (p. ej. `matches_by_player`, partición `player_id`, clustering `ended_at DESC`) diseñada desde esa consulta.
- **P7 (comportamiento irregular):** recorre relaciones entre jugadores (Neo4j). Si necesitara eventos por jugador, agregar `events_by_player` y escribirla en el paso 1.
- **P8 (reversión):** para saber qué anular se puede leer el log por partida; el log **no se modifica** (es inmutable): la anulación se registra con un evento nuevo o en `matches.status = "voided"`.
- Cualquier cambio en el script Lua debe reflejarse en `InMemoryLiveScoreboard`.

## Cómo extender

- **Nuevo tipo de evento** (p. ej. `assist`): agregarlo a `matchEventTypes` (`matchEvent.ts`), a las reglas de `matchEventSchema.ts` y de `pointsFor` (`matchEventService.ts`), a una rama del script Lua y al fake en memoria, y a `expectedScoreboard` en el script de demo. El log no cambia (`event_type` es texto).
- **Nueva tabla de Cassandra**: definir primero la consulta, agregarla a `init.cql` y a la tabla de consultas de arriba, y escribirla desde el mismo paso 1 (idempotente por clave primaria).

## Preguntas contrafactuales (para el informe)

- *¿Y si el marcador viviera solo en Cassandra?* Cada lectura sería una agregación sobre la partición (o un `counter`, que no es idempotente: un reintento duplica el conteo y Cassandra no tiene scripts atómicos de verificación y suma). Perdemos el "al instante".
- *¿Y si los eventos vivieran solo en Redis?* No hay durabilidad ni volumen sostenido razonable en memoria; "todos los eventos deben conservarse" se rompe ante un reinicio o una política de evicción, y el historial crece sin techo en RAM.
- *¿Y si los eventos vivieran en Mongo?* Funcionaría con volumen bajo, pero las escrituras de muchas partidas simultáneas con una clave de partición natural por partida y lectura ordenada por tiempo son el caso de Cassandra; en Mongo habría que cuidar índices y crecimiento de la colección, sin ganar nada (no hay consultas por documento complejo).
