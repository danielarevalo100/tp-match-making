# Problema 6 — Historial y estadísticas del jugador

Consigna: obtener las **últimas 50 partidas** de un jugador y sus **estadísticas por período** (semana, mes, temporada): partidas, victorias, relación eliminaciones/muertes y evolución del rating. Tipo: **Consulta**.

Requiere haber leído `problema4.md`: de ahí sale la partida cerrada con su marcador final (`finalScoreboard`).

## Motores y responsabilidades

| Motor         | Rol en P6                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cassandra** | **Historial de partidas por jugador** (`gaming.match_history_by_player`). Es el dato masivo: se escribe una vez al cerrarse la partida y no se actualiza.                                     |
| **MongoDB**   | Existencia y perfil del jugador (`players`) y calendario de temporadas (`seasons`). También es la **fuente** desde la que se proyecta el historial (partidas `closed` con scoring `applied`). |
| Redis, Neo4j  | No intervienen.                                                                                                                                                                               |

### Por qué Cassandra

El enunciado del dominio dice que el historial es **masivo, de solo escritura una vez cerrada la partida, y se consulta por jugador o por período**. Eso es exactamente una tabla de Cassandra modelada por la consulta:

```text
PRIMARY KEY ((player_id), ended_at, match_id)   CLUSTERING ORDER BY (ended_at DESC, match_id ASC)
```

- Una partición por jugador, ordenada de la más nueva a la más vieja.
- "Últimas 50" = `WHERE player_id = ? LIMIT 50`: lee las primeras 50 filas de una partición, sin ordenar ni filtrar.
- "Partidas desde X" = `WHERE player_id = ? AND ended_at >= ?`: un rango contiguo de la misma partición.
- El costo de ambas lecturas **no depende de cuántas partidas tiene la plataforma**, solo de cuántas tiene el jugador.

Un mismo hecho (una partida) se escribe en **una fila por participante**. Esa duplicación es deliberada: cada jugador tiene su propia partición para poder leer su historial sin cruzar particiones. Quien la mantiene es la proyección (`PlayerHistoryProjectionService`).

Por qué no los otros motores: Mongo podría guardar el historial (hay un índice `players.playerId + createdAt` en `matches`), pero es el tipo de dato que Mongo no necesita ordenar ni indexar: crece sin parar y nunca se modifica. Redis no es durable a ese volumen. Neo4j no aporta nada: no hay relaciones que recorrer.

### Estadísticas derivadas, no almacenadas

`ESTADISTICAS_JUGADOR` del DER de la etapa 1 es un dato **derivado** (recomendación de la sección 13). Se calcula al leer, a partir de las filas del historial (`periodStats.ts`). Así no hay contadores que puedan quedar desincronizados de las partidas, y cualquier período nuevo es solo otra ventana de tiempo. El costo es leer las filas del período (acotado por jugador); si en algún momento fuera un problema, se puede agregar una tabla de agregados semanales, que sí sería una desnormalización a documentar.

## Identificadores

- `playerId`: el UUID de `players._id` (Mongo). Es `player_id` en Cassandra.
- `matchId`: el UUID de la partida (P2/P4). Es `match_id` en Cassandra y `_id` en Mongo.

## Lectura: `PlayerHistoryService.getHistory`

`GET /history/players/:playerId` (`business/services/playerHistoryService.ts`):

| Paso | Motor     | Acción                                                                                                |
| ---- | --------- | ----------------------------------------------------------------------------------------------------- |
| 1    | Mongo     | El jugador existe (si no: `404 PLAYER_NOT_FOUND`) y su `username` y ratings actuales.                 |
| 2    | Mongo     | Temporada activa (`seasons.status = active`).                                                         |
| 3a   | Cassandra | `SELECT ... WHERE player_id = ? LIMIT 50`.                                                            |
| 3b   | Cassandra | `SELECT ... WHERE player_id = ? AND ended_at >= <inicio del período más largo>` (paginado de a 1000). |

3a y 3b corren en paralelo. Con las filas de 3b se calculan las **tres ventanas en memoria** en una sola pasada.

### Períodos

| Período  | Ventana                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `week`   | últimos 7 días hasta ahora                                                                                  |
| `month`  | últimos 30 días hasta ahora                                                                                 |
| `season` | desde `startsAt` de la temporada activa hasta ahora (`null` si no hay temporada activa o todavía no empezó) |

Son ventanas **móviles**, no semanas/meses calendario: es una decisión de interpretación de la consigna, fácil de cambiar en un solo lugar (`playerHistoryService.ts`).

### Qué devuelve cada período

`matches`, `wins`, `losses`, `draws`, `winRate` (null sin partidas), `kills`, `deaths`, `killDeathRatio` (null si no hay muertes: no es infinito, es indefinido) y `ratingEvolution`: por modo, `from` (el `mmrBefore` de la primera partida del período), `to` (el `mmrAfter` de la última), `change` y `points` (`mmrAfter` partida a partida, últimos 100 como máximo).

La evolución usa los **snapshots** `mmr_before` / `mmr_after` guardados en cada fila, no el rating actual del jugador (regla del DER: son datos históricos, distintos del rating vigente).

## Proyección: cómo llega la partida al historial

P4 deja la partida cerrada en Mongo con su `finalScoreboard` (por jugador: kills, deaths, objetivos, score, resultado, `mmrBefore`, `mmrAfter`, `ratingDelta`). `PlayerHistoryProjectionService` la lee y escribe una fila por jugador en Cassandra:

`POST /history/projection` con `{ "afterId"?: uuid, "limit"?: 10000, "since"?: ISO }` → `{ matches, rows, nextCursor }`.

- **Idempotente**: la clave `(player_id, ended_at, match_id)` hace que reproyectar una partida sobrescriba las mismas filas. No hay duplicados aunque se repita.
- **Reanudable**: recorre Mongo por `_id` y devuelve `nextCursor`; pasarlo como `afterId` continúa donde quedó. Si el proceso cae a mitad, se reintenta desde el último cursor.
- **Solo lectura sobre Mongo**: no modifica nada de P4.

Este paso es un **punto de integración pendiente**: hoy la proyección se dispara a mano (o desde el script de carga). Cuando se quiera que el historial se escriba en el cierre, alcanza con llamar a `PlayerHistoryProjectionService` para ese `matchId` al final de `MatchClosureService.scoreIfNeeded` (después de `completeScoring`). No se hizo para no tocar P4 mientras el resto del equipo trabaja sobre él.

## Fallas

P6 es una consulta: no escribe en dos motores ni necesita compensación.

| Falla                   | Resultado                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Mongo caído             | `503 STORAGE_ERROR engine=mongo`. Nada que deshacer.                                    |
| Cassandra caído         | `503 STORAGE_ERROR engine=cassandra`. Nada que deshacer.                                |
| Proyección interrumpida | Las filas ya escritas son válidas; reanudar con `nextCursor` o repetir desde el inicio. |

Pasos para `x-fail-at`: `playerHistory.findPlayer`, `playerHistory.findActiveSeason`, `playerHistory.findLatest`, `playerHistory.findSince`, `playerHistory.listClosedMatches`, `playerHistory.appendRows`.

## Preguntas contrafactuales

- **¿Y si el historial viviera en Mongo?** Funciona con los volúmenes del TP, pero la colección `matches` (cada documento con su marcador completo) tendría que servir a la vez de máquina de estados de P4 y de historial. Las últimas 50 de un jugador exigen un índice por jugador + fecha sobre una colección que crece con cada partida y que además se actualiza (P4 cambia su estado varias veces).
- **¿Y si las estadísticas se guardaran en un contador (`ESTADISTICAS_JUGADOR`)?** Habría que mantener el contador sincronizado con cada cierre y, peor, con cada anulación (P8). Una falla entre las dos escrituras lo deja mentiroso. Derivarlas del historial elimina esa clase de errores.
- **¿Y si el historial fuera una sola tabla particionada por fecha?** "Últimas 50 de un jugador" pasaría a leer muchas particiones y filtrar. Es la consulta más frecuente; por eso la partición es el jugador.

## Pruebas

`test/unit/modules/playerHistory/playerHistory.test.ts` (servicio, proyección y API con fakes en memoria): últimas 50 ordenadas, las tres ventanas, evolución del rating, ratio sin muertes, jugador sin partidas, 404/400, falla inyectada, proyección reanudable e idempotente.

Verificado además contra los motores reales con el script de carga (`pnpm seed`, ver README del módulo): 50.000 partidas → 100.000 filas, y la consulta de un jugador responde en ~100 ms incluyendo ambos motores.

## Limitaciones conocidas

- La proyección no está enganchada al cierre de P4 (ver arriba).
- Las ventanas son móviles y la temporada es solo la activa.
- `points` de la evolución del rating se recorta a los últimos 100 por modo.
- Un jugador con miles de partidas en una temporada lee todas sus filas para armar la ventana de temporada.
