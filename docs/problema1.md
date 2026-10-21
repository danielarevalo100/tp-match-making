# Problema 1 — Ingreso a la cola de matchmaking

Consigna: un jugador entra a la cola de un modo y región con su rating de ese modo. No puede estar en dos colas a la vez, ni entrar si tiene una partida activa o una sanción vigente. Tipo: **Escritura** (sin rollback obligatorio).

Este documento describe cómo está resuelto, para que quien implemente los problemas siguientes sepa qué existe y qué contratos respetar.

## Motores y responsabilidades

| Motor | Rol en este problema |
|---|---|
| **MongoDB** | Fuente de verdad durable. Se **lee** para validar elegibilidad: jugador (`players`), modo (`game_modes`), región (`regions`), sanciones (`sanctions`). No se escribe nada. |
| **Redis** | Estado vivo de la cola. Se **escribe** el ticket y las dos colas ordenadas. |

Cassandra y Neo4j no intervienen.

## Identificadores compartidos

- `playerId` (UUID): `players._id` en Mongo, y parte de las claves de Redis (`mm:ticket:{playerId}`, `player:{playerId}:active_match`).
- `ticketId` (UUID): token de idempotencia de la cola. Lo manda el cliente (opcional) o lo genera el servidor. Vive solo en Redis.

## Modelo de datos en Redis

| Clave | Tipo | Contenido |
|---|---|---|
| `mm:ticket:{playerId}` | HASH | `ticketId, playerId, mode, region, mmr, enqueuedAt (ms)`. Su existencia garantiza una sola cola por jugador. |
| `mm:q:{mode}:{region}:rating` | ZSET | miembro = `playerId`, score = `mmr`. Sirve para buscar ratings parecidos (Problema 2). |
| `mm:q:{mode}:{region}:wait` | ZSET | miembro = `playerId`, score = `enqueuedAt`. Sirve para hallar al que más espera y ampliar el rango. |
| `player:{playerId}:active_match` | STRING | `matchId` de la partida del jugador. Lo escribe el Problema 2, lo lee este. |

Definiciones de claves en `gamingApp/src/shared/storageKeys.ts` (`redisKeys`, `mongoCollections`).

**Desnormalización deliberada:** el ticket guarda una copia del `mmr` leído de Mongo (`players.ratings.<modo>.mmr`, o `game_modes.initialRating` si el jugador no tiene rating en ese modo). No se desactualiza mientras el jugador está en cola: el rating solo cambia al cerrar una partida (P4) o revertir una sanción (P8), y un jugador en cola no está en ninguno de los dos. Responsable de la coherencia: el módulo matchmaking.

## Flujo (`MatchmakingService.enqueue`)

Archivo: `gamingApp/src/api/modules/matchmaking/business/services/matchmakingService.ts`.

1. Lee el jugador en Mongo → `PlayerNotFoundError` si no existe; `AccountNotActiveError` si `accountStatus !== "active"`.
2. Lee el modo activo → `ModeNotAvailableError`.
3. Región = la pedida o la del jugador (`players.region`, derivada del país al registrarse) → `RegionNotFoundError` si no está activa.
4. Busca **sanción vigente** → `PlayerSanctionedError`. Vigente = `status: "active"`, `startsAt <= ahora` y (`endsAt` nulo **o** `endsAt > ahora`). `endsAt = null` es permanente. Todos los tipos de sanción bloquean.
5. Ejecuta el script Lua de entrada (`enqueueScript`) en Redis.
6. Si entró (o fue un reintento), **vuelve a chequear sanciones**. Cubre la carrera “se sancionó entre el paso 4 y la escritura”: si ahora hay sanción, saca al jugador de la cola y lanza `PlayerSanctionedError`.

## Atomicidad: `enqueueScript`

Archivo: `gamingApp/src/api/modules/matchmaking/infrastructure/scripts/matchmakingScripts.ts`.

En un solo paso atómico de Redis:
1. Si ya existe `mm:ticket:{playerId}`: devuelve `REPLAYED` (mismo `ticketId`) o `ALREADY_IN_QUEUE` (otro `ticketId`), con el ticket existente.
2. Si existe `active_match`: devuelve `ALREADY_IN_MATCH` + `matchId`.
3. Si no: escribe el HASH y hace `ZADD` en ambas colas; devuelve `ENQUEUED`.

Por eso 50 pedidos concurrentes del mismo jugador producen exactamente un ticket (hay test de integración).

**Idempotencia:** reintentar con el mismo `ticketId` devuelve el ticket existente (`200`, `created: false`) sin duplicar.

## Salir de la cola y sanciones posteriores

- `leave(playerId)` (`redisQueueAdapter.ts`): lee el ticket para conocer modo/región (las claves de las colas dependen de ellos) y ejecuta `leaveScript`, que borra el ticket y las dos entradas ZSET solo si el `ticketId` coincide; reintenta hasta 3 veces si el ticket cambió. Desde el Problema 2, si no hay ticket pero el jugador está **reservado en una formación**, lo registra como abandono (ver `problema2.md`).
- `evictIfSanctioned(playerId)`: para cuando se sanciona a alguien que ya está en cola; si tiene sanción vigente lo saca. Lo usa el Problema 8.
- Los tickets **no expiran** por TTL; los obsoletos los maneja la formación (P2).

## API

Router: `presentation/routers/matchmakingRouter.ts`; controlador: `matchmakingController.ts`; validación con zod en `presentation/schemas/matchmakingSchema.ts`.

| Método y ruta | Respuesta |
|---|---|
| `POST /matchmaking/queue` `{mode, playerId, region?, ticketId?}` | `201` ticket nuevo, `200` reintento idempotente |
| `GET /matchmaking/queue/:playerId` | ticket o `404 TICKET_NOT_FOUND` |
| `DELETE /matchmaking/queue/:playerId` | `204` o `404` |
| `POST /matchmaking/queue/:playerId/sanction-check` | `{evicted, sanctioned, sanction?}` |

Errores → HTTP (`api/errorHandler.ts`): `PLAYER_NOT_FOUND` 404, `ACCOUNT_NOT_ACTIVE`/`MODE_NOT_AVAILABLE`/`REGION_NOT_FOUND` 422, `PLAYER_SANCTIONED` 403, `ALREADY_IN_QUEUE`/`ALREADY_IN_MATCH` 409.

## Arquitectura de código (patrón que siguen todos los módulos)

```
business/   models, ports (interfaces), services   ← lógica, sin dependencias de motores
infrastructure/ adapters (Mongo/Redis), mappers, scripts Lua
presentation/ router, controller, schemas (zod)
composition/  cablea adaptadores con servicios (matchmakingComposition.ts)
```

Los adaptadores extienden `BaseMongoAdapter` / `BaseRedisAdapter` → `BaseAdapter.run(step, fn)`. **`run` es el mecanismo de inyección de fallas**: si el header HTTP `x-fail-at` coincide con el nombre del paso, lanza `InjectedFailureError` (500 `INJECTED_FAILURE`); los errores del driver se envuelven en `StorageError` (503). El contexto del pedido se propaga con `AsyncLocalStorage` (`shared/requestContext.ts`, `middlewares/faultInjectionMiddleware.ts`).

Pasos con nombre usados acá: `matchmaking.findPlayer`, `findActiveMode`, `isActiveRegion`, `findSanctionInForce`, `enqueue`, `findTicket`, `leave`.

## Tests y demo

- Unitarios (sin motores): `gamingApp/test/unit/modules/matchmaking/matchmakingApi.test.ts`, usando los fakes de `test/support/inMemory/`.
- Integración con Redis real: `test/integration/redisQueueAdapter.test.ts` (se saltea sin `REDIS_URL`).
- Demo end-to-end contra Docker: `scripts/demo-problem-1.sh` / `.ps1` (registra un jugador y recorre éxito, reintento, segunda cola, partida activa, sanción y ráfaga concurrente).

## Qué asumen los problemas siguientes

- P2 consume `mm:ticket`, las dos ZSET y `active_match` con exactamente este formato.
- El `mmr` del ticket es la fotografía al momento de entrar.
- Quien cree sanciones (P8) debe llamar a `evictIfSanctioned` para sacar de la cola a un jugador ya encolado.
