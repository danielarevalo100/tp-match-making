# Problema 8 — Sanción con reversión de resultados

## Consigna

> Un administrador sanciona a un jugador por trampa: se anulan los resultados de las partidas afectadas, se revierte el rating ganado por él y perdido por sus rivales y se recalculan los leaderboards. Además, dado un identificador de jugador, obtener en una sola consulta su perfil, ratings por modo, posición en leaderboards, sanciones y últimas partidas.
>
> **Condición de falla:** si la reversión falla en alguna partida, la sanción debe quedar registrada pero la reversión debe completarse o deshacerse de forma consistente, sin leaderboards con resultados parcialmente anulados.

Tipo: **escritura con falla y rollback** (la sanción) y **consulta de trazabilidad** (el perfil).

Requiere haber leído [`problema4.md`](problema4.md) (cómo se aplica el rating), [`problema5.md`](problema5.md) (cómo se publica el leaderboard), [`problema6.md`](problema6.md) (historial) y [`problema7.md`](problema7.md) (grafo).

## Decisiones de interpretación

| Frase | Cómo se interpretó |
|---|---|
| "las partidas afectadas" | Las partidas en las que **hubo trampa**, que el administrador lista explícitamente (`matchIds`). No se infieren por período: una partida limpia del mismo jugador no se toca. Si la sanción nace de un reporte, el reporte puede traer el `matchId` denunciado. |
| "se anulan los resultados" | La partida pasa a `voided` y deja de contar en todos lados: rating, partidas jugadas, registro de temporada, historial (P6), grafo de coparticipación (P7) y leaderboard (P5). |
| "se revierte el rating ganado por él y perdido por sus rivales" | Se resta a **cada participante** el `ratingDelta` que P4 le aplicó en esa partida (al tramposo se le saca lo que ganó y a cada rival se le devuelve lo que perdió). Como los deltas son fijos (±25), restar es correcto aunque haya partidas posteriores. |
| "se recalculan los leaderboards" | Los afectados se republican con el valor que queda en MongoDB. El sancionado **no se quita** del ranking: queda con su rating revertido. P5 dejó abiertas las dos opciones ("quitarlas o recalcular"); se eligió recalcular porque quitarlo sin marcarlo en MongoDB haría que un `rebuild` lo vuelva a agregar. Si un jugador se queda sin partidas válidas en la temporada, sí sale del ranking (ver [Registro sin partidas](#registro-de-temporada-sin-partidas)). |
| "completarse o deshacerse" | Se eligió **completar**: la reversión solo avanza, cada paso es repetible y un fallo se resuelve reintentando. Ver [Por qué completar y no deshacer](#por-qué-completar-y-no-deshacer). |

## Motores y responsabilidades

| Motor | Responsabilidad en P8 |
|---|---|
| **MongoDB** | La sanción y el **journal** de la reversión (`sanctions`); el estado `voided` de la partida (`matches`); rating y registros de temporada (`players`). Es donde la sanción "queda registrada". |
| **Redis** | Saca al jugador de la cola de matchmaking (P1). **Retiene** a los jugadores afectados en el leaderboard y al final publica a todos juntos en una sola operación atómica por tablero (P5). |
| **Cassandra** | Borra las filas de las partidas anuladas del historial por jugador (`match_history_by_player`, P6). Las estadísticas de P6 se derivan de esas filas, así que se corrigen solas. |
| **Neo4j** | Borra el nodo `Match` y sus relaciones `PLAYED` (P7), para que una partida anulada no genere alertas de acuerdo de resultados. |

La consulta de perfil lee MongoDB (perfil, ratings, sanciones), Redis (posiciones) y Cassandra (últimas partidas).

## Identificadores

- `sanctionId`: UUID que **elige quien llama**, igual que `closureId` en P4 o `ticketId` en P1. Es la clave de idempotencia: repetir el request con el mismo id continúa la misma sanción y nunca crea otra. Es `_id` en `sanctions` y el `holdId` de la retención en Redis.
- `playerId`: el UUID de `players._id`. Es el mismo en Redis (miembros de los ZSET y del hash `held`), en Cassandra (`player_id`) y en Neo4j (`Player.id`).
- `matchId`: el de P2. Es `_id` en `matches`, `match_id` en Cassandra y `Match.id` en Neo4j. En `players` aparece en `appliedRatingMatches` (P4) y ahora también en `revertedRatingMatches` (P8).

## Flujo y orden de escrituras

`POST /sanctions` (`SanctionService.sanction`):

```text
 Administrador          gaming-app             MongoDB           Redis          Cassandra   Neo4j
      │  POST /sanctions     │                     │                 │                │          │
      │─────────────────────>│ validar (lecturas)  │                 │                │          │
      │                      │────────────────────>│                 │                │          │
      │                      │ 0. insert sanción   │                 │                │          │
      │                      │────────────────────>│  ← la sanción queda registrada (en vigor)    │
      │                      │ 1. sacar de la cola │                 │                │          │
      │                      │──────────────────────────────────────>│                │          │
      │                      │ 2. retener afectados│                 │                │          │
      │                      │──────────────────────────────────────>│ (hold)         │          │
      │                      │ 3. por cada partida:│                 │                │          │
      │                      │    voided ─────────>│                 │                │          │
      │                      │    rating y         │                 │                │          │
      │                      │    temporadas ─────>│                 │                │          │
      │                      │    historial ──────────────────────────────────────────>│          │
      │                      │    grafo ──────────────────────────────────────────────────────────>│
      │                      │    journal ────────>│                 │                │          │
      │                      │ 4. publicar y soltar│                 │                │          │
      │                      │──────────────────────────────────────>│ (1 script/tablero)        │
      │                      │ 5. completed ──────>│                 │                │          │
      │<─────────────────────│ 201                 │                 │                │          │
```

| Paso | Motor | Acción | Registro en el journal |
|---|---|---|---|
| — | Mongo (lecturas) | El jugador existe; el administrador existe y está activo; el reporte (si viene) es sobre ese jugador; cada partida existe, está `closed` con `scoringStatus=applied` (o ya `voided`) y el sancionado jugó en ella. | — |
| 0 | Mongo | `insertOne` de la sanción con `status=active` y `reversal.status=pending`. | El documento mismo. |
| 1 | Redis | El jugador sale de la cola (`RedisQueueAdapter.leave`, el mismo de P1). Si estaba reservado en una formación, la abandona y P2 la rechaza. | `completedSteps += queue` |
| 2 | Redis | **Retención**: por cada tablero (temporada, modo) afectado, los participantes de las partidas anuladas quedan retenidos. Desde ahora ni P4 ni el `rebuild` de P5 los publican. | `completedSteps += hold`, `heldBoards` |
| 3a | Mongo | `matches`: `closed → voided` con `voided: { sanctionId, at }`. | — |
| 3b | Mongo | `players`: por cada participante, un único update atómico resta el delta a `ratings.<modo>` y a los registros de temporada afectados, y descuenta la partida jugada. | — |
| 3c | Cassandra | `DELETE` de la fila de cada participante en `match_history_by_player`. | — |
| 3d | Neo4j | `DETACH DELETE` del nodo `Match`. | — |
| 3e | Mongo | — | `revertedMatchIds += matchId` |
| 4 | Redis | Por cada tablero, **un único script Lua** suelta la retención y escribe el registro actual de cada retenido (publica, o lo quita si se quedó sin partidas). Después, una puesta al día con el `publishScript` normal. | `completedSteps += leaderboard` |
| 5 | Mongo | `reversal.status = completed`. | `completedAt` |

### Por qué este orden

- **La sanción primero, sola.** Es la parte que la consigna exige conservar pase lo que pase. Desde el `insert`, P1 ya la ve en vigor y rechaza al jugador en la cola, aunque la reversión todavía no haya empezado. Antes del `insert` solo hubo lecturas: un request rechazado no deja rastro.
- **La cola enseguida.** Cierra la ventana que P1 documenta: una sanción creada justo después del chequeo de P1 dejaría al jugador encolado. El paso no depende de la reversión.
- **Retener antes de tocar un rating.** Es lo que garantiza la condición de falla (ver la próxima sección). Una retención en Redis es barata y repetible.
- **`voided` antes que los borrados.** Desde que la partida es `voided`, las proyecciones de P6 y P7 la ignoran (solo leen `closed` + `applied`) y P4 rechaza un nuevo `finish`. Si se borrara primero el historial, una proyección que corra en el medio podría volver a escribirlo.
- **Redis al final, como en P4.** MongoDB es la fuente de verdad y el leaderboard es su proyección: una falla solo puede dejar el leaderboard **atrasado**, nunca adelantado.

## La retención: leaderboard sin resultados parcialmente anulados

El problema: MongoDB es la fuente del leaderboard, y P4 publica lo que MongoDB tiene **en ese momento**. Si la reversión se cae después de revertir la partida 1 y antes de la 2, y mientras tanto uno de los rivales de la partida 1 juega otra partida, P4 publicaría su rating ya restituido. El tablero mostraría la partida 1 anulada para él y no para el tramposo, que es justo lo que la consigna prohíbe. Y esa situación podría durar horas si nadie reintenta.

La solución es **retener** a los afectados. Dos estructuras Redis por tablero:

| Clave | Tipo | Contenido |
|---|---|---|
| `lb:{season}:{mode}:holds` | SET | `{sanctionId}\|{playerId}`: qué sanción retiene a quién. Hace idempotente la retención (un reintento no cuenta dos veces). |
| `lb:{season}:{mode}:held` | HASH | `playerId → cantidad de sanciones que lo retienen`. Dos sanciones que comparten un rival lo retienen a la vez; se suelta cuando la última termina. |

Reglas, todas dentro de scripts Lua (atómicas):

- `publishScript` (P4 y `rebuild`) y `removeScript` (`rebuild`) **saltean** a un jugador con `held` > 0. El resto del tablero sigue moviéndose con normalidad.
- `releaseScript` (P8, paso 4) recibe a **todos** los retenidos del tablero. Por cada uno: saca su miembro del SET y baja el contador; si nadie más lo retiene, escribe su registro actual de MongoDB (con el mismo control de `revision` que P5). Todo el tablero va en **una sola llamada**, sin lotes, así que un lector ve la reversión entera o nada.

Mientras la reversión está incompleta, los retenidos muestran exactamente el valor que tenían antes de la sanción: el tablero es consistente con "nada anulado". Cuando P4 cerró una partida nueva de un retenido, su cambio no se pierde: queda en MongoDB y la publicación final lo incluye.

Queda una ventana chica: que P4 cierre una partida de un retenido entre la lectura de MongoDB y el `releaseScript`. Su publicación se saltea (el jugador todavía está retenido) y la de P8 lleva el valor anterior. Por eso, después de soltar, P8 vuelve a leer MongoDB y republica a los afectados con el `publishScript` normal (**puesta al día**). El tablero ya era consistente; esto solo evita que quede atrasado, y el control de `revision` impide que retroceda a nadie.

### Registro de temporada sin partidas

Si se anulan todas las partidas que un jugador tenía en una temporada, su `gamesPlayed` de esa temporada queda en 0. El registro **no se borra**, para que `revision` siga creciendo (si se borrara y el jugador volviera a jugar, arrancaría en `revision` 1 y Redis ignoraría la publicación). Un registro con `gamesPlayed = 0` no está en el ranking:

- `releaseScript` lo quita del tablero global y del regional y deja en el hash `members` la marca `"{revision}|"` (una **lápida**). Así, una publicación vieja que llegue tarde no lo puede traer de vuelta.
- El adapter Mongo de P5 ignora estos registros en `findStandings` y `listStandings`, así que un `rebuild` no lo agrega y además limpia la lápida.

## Rating y registros de temporada

Por cada participante de cada partida anulada, **un solo `updateOne` con pipeline** (misma técnica que `applyRating` de P4):

```text
filtro: _id = playerId AND appliedRatingMatches = matchId AND revertedRatingMatches != matchId
```

- `ratings.<modo>.mmr -= delta` y `ratings.<modo>.gamesPlayed -= 1` (nunca menos de 0).
- `revertedRatingMatches += matchId` en la misma escritura: es la guarda de idempotencia, el espejo de `appliedRatingMatches`.
- Registros de temporada: el MMR **no se reinicia** entre temporadas, así que el delta de una partida está incluido en el registro de su temporada y en el de **todas las posteriores** donde el jugador tenga registro. A todos ellos se les resta el delta y se les suma 1 a `revision`; solo el de la temporada de la partida descuenta `gamesPlayed`.
- La temporada de la partida es la que contiene su `createdAt` y solo si el modo es ranked: la misma regla que usa P4 (`reversalRules.affectedSeasons`).

Si P4 nunca aplicó el rating a ese jugador (`appliedRatingMatches` no tiene la partida), el filtro no encuentra el documento y no se hace nada: no se revierte lo que no se aplicó.

## Journal y recuperación

El journal vive dentro del documento de la sanción (`sanctions.reversal`):

```text
reversal = {
  status: pending | reverting | completed | failed,
  attempts, lastError, updatedAt, completedAt,
  completedSteps: [queue, hold, leaderboard],
  heldBoards: [{ seasonId, mode, playerIds }],   ← lo que hay que soltar
  revertedMatchIds: [ ... ]                      ← partidas ya revertidas
}
```

```text
pending ──> reverting ──> completed
                │
                └──> failed ──> reverting   (reintento del POST o POST /resume)
```

Ante una caída, el journal dice exactamente qué falta: qué pasos de nivel sanción no terminaron, qué partidas no se revirtieron y qué tableros están retenidos. Un reintento retoma desde el primer paso faltante. Dentro de una partida no hace falta más detalle, porque todos sus pasos (3a a 3d) son idempotentes: si se cortó a la mitad, se rehace entera sin efectos dobles.

Formas de retomar:

- repetir `POST /sanctions` con el mismo cuerpo (el `sanctionId` lo identifica);
- `POST /sanctions/:sanctionId/resume`, que lee todo del journal y no necesita el cuerpo. Es lo que haría un worker.

## Por qué completar y no deshacer

La consigna acepta las dos salidas. Se eligió **completar hacia adelante** porque:

1. **Cada paso es repetible**: guardas por `matchId` en Mongo, `DELETE` en Cassandra, `DETACH DELETE` en Neo4j y control de revisión en Redis. Reintentar es seguro y es lo mismo que hace el cierre de P4.
2. **Deshacer exige compensaciones de las compensaciones**: devolver el rating, reinsertar filas de historial con los mismos datos y volver a crear el nodo en Neo4j. Son más escrituras que pueden fallar y no aportan consistencia.
3. **La retención hace que esperar sea seguro**: mientras no se completa, el leaderboard muestra el estado anterior completo, sin anulaciones a medias.
4. **El objetivo de negocio**: una reversión deshecha deja al tramposo con los puntos que obtuvo haciendo trampa.

Lo único que se compensa es lo que pasa **antes** de registrar la sanción, y ahí no hay nada que compensar: solo hubo lecturas.

## Qué pasa si falla cada paso

| Falla en | Estado que queda | Respuesta | Recuperación |
|---|---|---|---|
| Validación (lecturas) | Nada escrito | `404`/`422`/`503` | Corregir el request. |
| `sanctions.insertSanction` | Nada escrito | `500` (inyectada) o `503` | Repetir el request. |
| `matchmaking.leave` | Sanción en vigor; nada retenido ni revertido | `202`, `reversal.status=failed` | Reintentar o `resume`. |
| `leaderboard.hold` (o a mitad de los tableros) | Sanción en vigor; algunos tableros retenidos; ningún rating tocado | `202` | Reintentar: la retención es idempotente. |
| Cualquier paso 3a–3e de una partida | Partidas anteriores revertidas en Mongo, Cassandra y Neo4j; esta, a medias; **leaderboard sin cambios (retenido)** | `202`, `pendingMatchIds` | Reintentar: la partida a medias se rehace entera sin duplicar. |
| `leaderboard.release` | Todo revertido en Mongo, Cassandra y Neo4j; leaderboard **sin cambios (retenido)** | `202` | Reintentar: solo falta este paso. |
| `sanctions.completeReversal` | Todo aplicado; journal sin `completed` | `202` | Reintentar: los pasos ya hechos se saltean y se marca `completed`. |
| La app se cae en cualquier punto | Lo que diga el journal | — | `POST /sanctions/:id/resume`. |

En todas las filas, la sanción sigue en vigor y ningún leaderboard muestra resultados parcialmente anulados.

## Idempotencia

- `sanctionId` es `_id`: el índice único impide una segunda sanción con el mismo id. Si dos requests iguales llegan juntos, el que pierde el `insert` continúa la sanción del otro.
- Reusar un `sanctionId` con otros datos (jugador, administrador, tipo, reporte, fin o partidas distintas) da `409 SANCTION_CONFLICT`.
- `voidMatch` acepta una partida que ya está `voided` (por esta u otra sanción) sin error.
- Rating: guarda por `(matchId, playerId)` con `revertedRatingMatches`. Dos sanciones que incluyen la misma partida nunca revierten dos veces.
- Cassandra y Neo4j: borrar algo que ya no está no es un error.
- Redis: la retención usa un SET (un reintento no cuenta dos veces) y la publicación final, el control de `revision`.
- Una sanción `completed` repetida devuelve el mismo resultado (`200`) sin volver a escribir.

## Concurrencia

- **Dos sanciones sobre el mismo jugador o los mismos rivales:** el contador `held` permite que ambas retengan al mismo jugador; se publica cuando termina la última. Si comparten una partida, la segunda la encuentra `voided` y las guardas evitan revertirla otra vez.
- **P4 cerrando otra partida de un afectado durante la reversión:** sus escrituras en Mongo son relativas (`+delta`) y conmutan con las de P8 (`-delta`). Su publicación se saltea mientras el jugador está retenido, y la publicación final de P8 la incluye.
- **P4 con una partida anulada:** `finish` rechaza una partida `voided` (`409`).
- **Dos intentos de la misma sanción en paralelo:** todos los pasos son idempotentes. `failReversal` solo pasa de `reverting` a `failed`, así que nunca degrada una reversión que el otro intento completó.

## Consulta de perfil (trazabilidad)

`GET /profiles/:playerId?matches=10` (`PlayerProfileService`), en una sola llamada:

| Dato | Motor | Lectura |
|---|---|---|
| Perfil y ratings por modo | MongoDB | `players` por `_id` |
| Sanciones | MongoDB | `sanctions` por `playerId`, más nuevas primero (índice `playerId + createdAt`) |
| Temporada activa | MongoDB | `seasons` con `status=active` |
| Posición global y regional por modo | Redis | `ZREVRANK` en `lb:{season}:{mode}:global` y en el regional (el mismo script `around` de P5) |
| Últimas partidas | Cassandra | `match_history_by_player WHERE player_id = ? LIMIT n` (el mismo adapter de P6) |

Las tres lecturas de Mongo y la de Cassandra corren en paralelo; las de Redis, en cuanto se sabe en qué modos tiene registro el jugador. Cada motor se consulta donde vive el dato, con el `playerId` compartido. No hay copias armadas para esta consulta, que es lo que pide la sección 6 de la consigna.

Ejemplo (resumido):

```json
{
  "player": { "id": "…", "username": "p8_cheater", "country": "AR", "region": "LATAM", "level": 10, "accountStatus": "active" },
  "ratings": [{ "mode": "ranked_1v1", "mmr": 1475, "gamesPlayed": 1 }],
  "seasonId": "2026-S2",
  "leaderboards": [{
    "seasonId": "2026-S2", "mode": "ranked_1v1", "mmr": 1475, "gamesPlayed": 1, "region": "LATAM",
    "global": { "position": 3120, "totalPlayers": 50003 },
    "regional": { "position": 512, "totalPlayers": 8366 }
  }],
  "sanctions": [{ "sanctionId": "…", "type": "permanent_ban", "status": "active", "inForce": true, "reversalStatus": "completed", "voidedMatches": 2 }],
  "recentMatches": [{ "matchId": "…", "result": "loss", "ratingDelta": -25, "…": "…" }]
}
```

## API

| Método | Ruta | Propósito |
|---|---|---|
| `POST` | `/sanctions` | Registra la sanción y revierte las partidas (idempotente por `sanctionId`) |
| `GET` | `/sanctions/:sanctionId` | Sanción y estado del journal |
| `POST` | `/sanctions/:sanctionId/resume` | Retoma una reversión incompleta desde el journal |
| `GET` | `/profiles/:playerId?matches=10` | Perfil completo (1 a 50 partidas) |

Cuerpo de `POST /sanctions`:

```json
{
  "sanctionId": "uuid",
  "playerId": "uuid",
  "administratorId": "uuid",
  "reportId": "uuid | null (opcional)",
  "type": "matchmaking_restriction | temporary_suspension | permanent_ban",
  "reason": "cheating (por defecto)",
  "description": "opcional",
  "startsAt": "ISO 8601 (opcional, por defecto ahora)",
  "endsAt": "ISO 8601 | null (opcional, null = permanente)",
  "matchIds": ["uuid", "… hasta 100, sin repetir"]
}
```

| Resultado | HTTP |
|---|---|
| Sanción creada y reversión completa | `201` |
| Mismo `sanctionId` repetido, reversión completa | `200` |
| Sanción registrada, reversión incompleta (`reversal.status=failed`) | `202` |

### Errores

| Caso | HTTP | `error` |
|---|---|---|
| Cuerpo inválido (uuid, partidas repetidas, `endsAt` antes de `startsAt`, campos extra) | 400 | `VALIDATION_ERROR` |
| Jugador inexistente | 404 | `PLAYER_NOT_FOUND` |
| Administrador inexistente | 404 | `ADMINISTRATOR_NOT_FOUND` |
| Administrador inactivo | 422 | `ADMINISTRATOR_NOT_ACTIVE` |
| Reporte inexistente o sobre otro jugador | 422 | `INVALID_SANCTION_REPORT` (`reason`) |
| Partida inexistente, sin el sancionado o sin scoring aplicado | 422 | `MATCH_NOT_REVERSIBLE` (`reason`: `not_found`, `not_participant`, `not_scored`) |
| `sanctionId` reusado con otros datos | 409 | `SANCTION_CONFLICT` |
| Sanción inexistente (`GET`, `resume`) | 404 | `SANCTION_NOT_FOUND` |
| Motor caído antes de registrar la sanción | 503 | `STORAGE_ERROR` |

## Inyección de fallas

Pasos para `x-fail-at`, en el orden en que se ejecutan:

```text
sanctions.findSanction  sanctions.findPlayer  sanctions.findAdministrator  sanctions.findReport
sanctions.findMatches   sanctions.insertSanction
matchmaking.leave       sanctions.markStep
sanctions.findSeasonCatalog  leaderboard.hold
sanctions.voidMatch  sanctions.revertRating  sanctions.deleteHistory  sanctions.deleteGraph
sanctions.markMatchReverted
sanctions.findStandings  leaderboard.release  leaderboard.publish (puesta al día)
sanctions.completeReversal  sanctions.beginReversal  sanctions.failReversal
profile.findPlayer  profile.findActiveSeason  profile.findSanctions  leaderboard.around  playerHistory.findLatest
```

Ejemplos para la defensa:

- `x-fail-at: sanctions.markMatchReverted` en `POST /sanctions`: la primera partida se revierte en los cuatro motores pero no se anota en el journal. La respuesta es `202`, el leaderboard no cambia y `resume` rehace esa partida sin revertirla dos veces.
- `x-fail-at: leaderboard.release`: todo revertido salvo Redis; el tablero muestra el estado anterior completo hasta el reintento.
- `x-fail-at: sanctions.insertSanction`: `500` y no queda ninguna sanción.
- Detener Cassandra (`docker compose stop cassandra`) y sancionar: la sanción queda registrada, la reversión `failed` en `sanctions.deleteHistory` y el leaderboard retenido. Al levantarla, `resume` completa.

## Simulación

```bash
node scripts/demo-problem-8.mjs
```

Requiere toda la stack de Compose, el schema aplicado y las dependencias de `gamingApp` instaladas. Carga directo en MongoDB el estado que deja P4 (tres jugadores y tres partidas cerradas), lo proyecta a Cassandra, Neo4j y Redis por la API, y recorre: la falla en la mitad, el `rebuild` con jugadores retenidos, `resume`, el reintento idempotente, la falla antes de registrar, una partida inválida y el bloqueo en la cola.

Para mostrarlo en vivo, la consola (`consola.cmd` o `node scripts/consola.mjs`) tiene dos opciones:

- **9) Sancionar jugador y anular partidas:** se elige el jugador (con los datos de la opción 13, `seed_player_0`), las partidas con trampa (las denunciadas aparecen primero), el administrador, el tipo y, opcionalmente, una falla: a mitad de la reversión (Cassandra, en la primera partida) o antes de registrar (MongoDB). Después muestra el journal de la sanción, el estado de las partidas, el rating de cada afectado en MongoDB contra el leaderboard de Redis (con la marca de retenido), las filas del historial y el nodo del grafo, y ofrece retomar la reversión.
- **10) Retomar una sanción incompleta:** lista las sanciones con la reversión `pending`, `reverting` o `failed` y hace `resume`.
- **11) Recorrido guiado completo:** termina sancionando al ganador de la partida que armó, con la falla a mitad de camino y el `resume`, y muestra su perfil.

## Modelo de datos

### MongoDB (`infra/mongo/init.js`, `schema_metadata` v8)

- `sanctions`: agrega `matchIds` y `reversal` (el journal). Las sanciones anteriores (sin `reversal`) se leen como una reversión ya completa sin partidas.
- `players`: agrega `revertedRatingMatches`. `seasonRatings.*.*.gamesPlayed` acepta 0.
- `matches`: `status=voided` (ya estaba en el enum) y `voided: { sanctionId, at }`.

> Hay que **reaplicar el schema** (`scripts/initialize-infrastructure.*`) en los volúmenes existentes: con el validador anterior, un registro de temporada con `gamesPlayed = 0` o un `reversal` en la sanción serían rechazados.

### Redis

| Clave | Tipo | Contenido |
|---|---|---|
| `lb:{season}:{mode}:holds` | SET | `{sanctionId}\|{playerId}` de cada retención activa |
| `lb:{season}:{mode}:held` | HASH | `playerId → cantidad de retenciones` |
| `lb:{season}:{mode}:members` | HASH | Igual que en P5; además `"{revision}\|"` como lápida de un jugador quitado por P8 |

### Cassandra y Neo4j

Sin cambios de esquema: se borra con la clave primaria completa (`player_id, ended_at, match_id`) y por `Match.id`.

## Desnormalización

P8 no agrega copias nuevas, pero tiene que mantener coherentes las que ya existían:

| Dato | Dónde | Quién lo mantiene en P8 |
|---|---|---|
| MMR | `ratings`, `seasonRatings` (Mongo) y ZSET (Redis) | Las dos copias de Mongo en el mismo update atómico; Redis al final con `releaseScript`. |
| Partida jugada | `matches` (Mongo), historial (Cassandra), grafo (Neo4j) | `voided` en Mongo primero; después borrado en Cassandra y Neo4j. |
| Partidas jugadas por temporada | `seasonRatings.gamesPlayed` (Mongo) y presencia en el tablero (Redis) | El mismo update y `releaseScript` (`remove` cuando llega a 0). |

## Preguntas contrafactuales (para el informe)

- **¿Y si el journal viviera en Redis?** Es el dato que dice qué falta deshacer o completar después de una caída, así que tiene que ser durable. Redis está configurado con AOF y `fsync` cada segundo: una caída puede perder el último segundo de escrituras, y con él la marca de un paso ya hecho o, peor, la propia sanción. MongoDB es el motor durable del sistema y ya es dueño de las sanciones. Además, la sanción y su journal están en el mismo documento: registrar la sanción y crear el journal es una sola escritura atómica.
- **¿Y si se usara una transacción multi-documento de MongoDB en vez del journal?** Necesita un replica set (la stack corre un `mongod` standalone) y además solo cubriría a Mongo: Redis, Cassandra y Neo4j quedarían afuera igual. El journal resuelve los cuatro motores con la misma lógica.
- **¿Y si el leaderboard se recalculara entero (`rebuild`) al final en lugar de retener?** No evita la ventana: entre la reversión en Mongo y el `rebuild`, P4 seguiría publicando valores ya revertidos. Además, `rebuild` publica en lotes de 500, no atómicamente, y recorre todos los jugadores de la temporada aunque los afectados sean tres.
- **¿Y si en Cassandra se marcara la fila como anulada en vez de borrarla?** Habría que cambiar las lecturas de P6 para filtrar, y la tabla seguiría creciendo con datos que no cuentan. El enunciado define el historial como "solo escritura una vez cerrada la partida": una anulación es la excepción, y un `DELETE` por clave primaria completa es una sola lápida en la partición del jugador.
- **¿Y si la reversión se deshiciera en lugar de completarse?** Ver [Por qué completar y no deshacer](#por-qué-completar-y-no-deshacer).

## Pruebas

- Servicio con fakes en memoria: `gamingApp/test/unit/modules/sanctions/sanctions.test.ts`. Cubre: reversión completa en los cuatro motores; reintento idempotente; `sanctionId` reusado (`409`); validaciones sin escrituras; partida sin scoring; falla antes de registrar; falla en la **segunda** partida con el leaderboard retenido mientras P4 sigue publicando, y `resume`; falla en la publicación final; partida de un retenido que cierra justo antes de soltarlo (puesta al día); falla al sacar de la cola; dos sanciones con una partida en común; temporada cerrada con desplazamiento de las posteriores; consulta de perfil.
- API: `gamingApp/test/unit/modules/sanctions/sanctionsApi.test.ts` (`201`, `200`, `202` + `resume`, `500` inyectado, `400`, `409`, `422`, `404`, perfil).
- Scripts Lua contra Redis real: retención, publicación salteada, dos retenciones sobre el mismo jugador, liberación con publicación, baja con lápida y movimiento de región.
- El doble en memoria del leaderboard (`InMemoryLeaderboardRanking`) replica la retención y la lápida, como pide P5.

## Limitaciones conocidas

- **Retención abandonada:** si una reversión queda `failed` y nadie la retoma, sus jugadores siguen retenidos (sin moverse en el tablero) indefinidamente. Un worker que haga `resume` de las sanciones con `reversal.status` en `pending`, `reverting` o `failed` lo resolvería. Por ahora es manual (`POST /sanctions/:id/resume`).
- **Partida en vivo del sancionado:** la sanción no termina la partida en curso. P4 la cierra normalmente y P1 le impide volver a la cola.
- **Temporada de la partida:** se toma la que contiene `createdAt`, como P4. Si una temporada se cerró entre que se formó la partida y que se calculó su scoring, P4 no la habrá contado y P8 igual descontaría `gamesPlayed` en esa temporada.
- **Tamaño:** cada tablero se publica en una sola llamada Lua para mantener la atomicidad. Hasta 100 partidas de hasta 50 jugadores son 5.000 entradas por llamada: Redis lo maneja, pero bloquea esa fracción de tiempo.
- **Proyecciones manuales de P6 y P7:** si una proyección leyó la partida antes de que fuera `voided` y escribe después del borrado, la vuelve a agregar. Volver a correr la proyección no la repara (ya no lee partidas `voided`); habría que repetir el borrado.
- **Sin autenticación:** cualquiera que alcance la API puede sancionar indicando un `administratorId` válido.

## Cambios en otros módulos

| Archivo | Cambio | Por qué |
|---|---|---|
| `leaderboards/infrastructure/scripts/leaderboardScripts.ts` | `publishScript` y `removeScript` saltean jugadores retenidos; nuevos `holdScript` y `releaseScript`. | La retención es lo que impide resultados parcialmente anulados. |
| `leaderboards/infrastructure/adapters/redisLeaderboardAdapter.ts` | Pasa la clave `held` a los scripts; nuevos `hold` y `release`. | Implementa el puerto de P8. |
| `leaderboards/infrastructure/adapters/mongoLeaderboardAdapter.ts` | Ignora registros con `gamesPlayed = 0`. | Un jugador sin partidas válidas no está en el ranking ni vuelve con `rebuild`. |
| `test/support/inMemory/inMemoryLeaderboards.ts` | Replica retención y lápida. | Regla de P5: el fake sigue a los scripts. |
| `shared/storageKeys.ts`, `api/errorHandler.ts`, `composition/createContainer.ts` | Claves, errores y rutas nuevas. | — |
| `infra/mongo/init.js` | Schema v8. | Ver [Modelo de datos](#modelo-de-datos). |

## Mapa de archivos

```text
gamingApp/src/api/modules/sanctions/
  business/models/                  sanción, journal, perfil y errores
  business/ports/                   Mongo (sanción y resultados), Redis (cola y leaderboard), Cassandra, Neo4j
  business/services/                sanctionService (orquestación), reversalRules (temporadas y tableros),
                                    playerProfileService (consulta de trazabilidad)
  infrastructure/adapters/          Mongo (sanción, reversión, perfil), Cassandra (historial), Neo4j (grafo)
  infrastructure/mappers/           documento de sanción <-> modelo
  presentation/                     schemas Zod, controllers y routers (/sanctions, /profiles)
gamingApp/src/composition/sanctionsComposition.ts
gamingApp/test/unit/modules/sanctions/
gamingApp/test/support/inMemory/inMemorySanctions.ts
gamingApp/test/support/sanctionScenario.ts
scripts/demo-problem-8.mjs
docs/problema8.md                   este análisis
```
