# Problema 7 — Detección de comportamiento irregular

Consigna: detectar (a) **grupos de jugadores que coinciden reiteradamente en partidas donde uno de ellos siempre se beneficia** (acuerdo de resultados) y (b) **jugadores con reportes cruzados de distintos denunciantes en poco tiempo**. Tipo: **Consulta**.

Requiere haber leído `problema4.md` (partidas cerradas con resultado por jugador) y `problema6.md` (misma fuente de datos, mismo patrón de proyección).

## Interpretación de la consigna

| Frase                                                        | Cómo se interpretó                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "coinciden reiteradamente en partidas"                       | Dos jugadores que estuvieron en la misma partida **del lado opuesto** (uno ganó, el otro perdió), al menos `minMatches` veces (por defecto 5) dentro de la ventana de `days` (por defecto 30). Los empates no cuentan: nadie se beneficia.                      |
| "uno de ellos siempre se beneficia"                          | El que más veces ganó entre los dos es el **beneficiario**; se marca si gana al menos `minBenefitRatio` de esos enfrentamientos (por defecto `1`, o sea siempre). Con igual cantidad de victorias no hay beneficiario.                                          |
| "grupos"                                                     | Un beneficiario con **todos** los rivales a los que gana así. Una pareja es un grupo de un solo socio.                                                                                                                                                          |
| "reportes cruzados de distintos denunciantes en poco tiempo" | Un jugador denunciado por al menos `minReporters` (por defecto 3) **denunciantes distintos** dentro de una ventana de `windowMinutes` (por defecto 60). Los reportes automáticos (sin denunciante) no cuentan, ni tampoco muchas denuncias de la misma persona. |

Los umbrales son parámetros, no constantes: la consigna no fija valores y un umbral duro (siempre, 5 partidas) deja afuera casos como 7-3 que a otro criterio le interesan.

## Motores y responsabilidades

| Motor            | Rol en P7                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neo4j**        | **Grafo de coparticipación**: `(:Player)-[:PLAYED {result, ratingDelta}]->(:Match)`. Responde "¿quién jugó contra quién, cuántas veces y con qué resultado?".                |
| **MongoDB**      | **Reportes** (`reports`): fuente de verdad de las denuncias. También los nombres de usuario (`players`) y la fuente de las partidas cerradas desde las que se arma el grafo. |
| Cassandra, Redis | No intervienen.                                                                                                                                                              |

### Por qué Neo4j para el acuerdo de resultados

La pregunta es un **patrón de relaciones**: encontrar pares `(a)-[:PLAYED]->(m)<-[:PLAYED]-(b)` que se repiten, contarlos y comparar resultados. En un grafo es un `MATCH` de un salto: los dos jugadores comparten un nodo `Match`.

```cypher
MATCH (a:Player)-[ra:PLAYED]->(match:Match)<-[rb:PLAYED]-(b:Player)
WHERE a.id < b.id AND match.endedAtMs >= $sinceMs
  AND ((ra.result = 'win' AND rb.result = 'loss') OR (ra.result = 'loss' AND rb.result = 'win'))
WITH a, b, count(match) AS matches, sum(CASE WHEN ra.result = 'win' THEN 1 ELSE 0 END) AS winsA
WHERE matches >= $minMatches
RETURN a.id, b.id, matches, winsA, matches - winsA AS winsB
```

Hacer esto en Mongo exige un `$unwind` de los jugadores de cada partida y un autojoin de la colección entera (`$lookup`), que no escala con la cantidad de partidas ni con el tamaño de la partida (en un modo de 50 jugadores cada partida genera 1.225 pares). En Cassandra no se puede consultar por "par de jugadores" sin crear una tabla por cada par posible. Y en modos por equipos, el mismo grafo permite luego agregar relaciones `TEAMMATE` sin cambiar el modelo.

El grafo **no es una copia de Mongo para leer más rápido**: tiene una responsabilidad propia (las consultas por relación que Mongo no resuelve). Lo que sí se duplica es el dato de base (quién jugó qué partida con qué resultado); quien lo mantiene es `FraudGraphProjectionService`.

### Por qué Mongo para los reportes

Los reportes ya viven en Mongo (`reports`, con `reportedPlayerId + createdAt` y ahora `createdAt` indexados). "Cuántos denunciantes distintos recibió cada jugador desde X" es un `$group` con `$addToSet`. No hay relación que recorrer: meter los reportes en el grafo sería replicar datos sin necesidad.

## Identificadores

`playerId` (UUID de `players._id`) y `matchId` son los mismos en Mongo, Cassandra y Neo4j: `Player.id` y `Match.id` en el grafo. Así el resultado de Neo4j se une con los nombres y los reportes de Mongo por el id compartido.

## Lectura: `FraudDetectionService`

### Acuerdo de resultados — `GET /fraud/match-fixing`

| Paso | Motor    | Acción                                                                                                           |
| ---- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| 1    | Neo4j    | Pares que se enfrentaron ≥ `minMatches` veces desde `since` (opcional: solo un `mode`).                          |
| 2    | (reglas) | `buildMatchFixingGroups` decide el beneficiario de cada par, aplica `minBenefitRatio` y agrupa por beneficiario. |
| 3    | Mongo    | Nombres de usuario de todos los involucrados (una sola consulta `$in`).                                          |

Parámetros: `days` (30), `minMatches` (5), `minBenefitRatio` (1, entre 0,5 y 1), `mode`, `limit` (50).

### Reportes cruzados — `GET /fraud/cross-reports`

| Paso | Motor    | Acción                                                                                                                                                        |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Mongo    | Aggregation: reportes con denunciante humano desde `since`, agrupados por denunciado; se descartan los de menos de `minReporters` denunciantes distintos.     |
| 2    | (reglas) | `findReportBursts`: para cada jugador busca la **ventana deslizante** de `windowMinutes` con más denunciantes distintos y lo marca si llega a `minReporters`. |
| 3    | Mongo    | Nombres de usuario.                                                                                                                                           |

La ventana deslizante se resuelve en la aplicación y no en Mongo para que el criterio ("poco tiempo") sea explícito y testeable; Mongo solo filtra lo que ya no puede ser sospechoso. Cinco denuncias de cinco personas repartidas en cinco días no se marcan; seis de la misma persona en diez minutos tampoco.

Parámetros: `days` (30), `minReporters` (3), `windowMinutes` (60).

### Las dos señales juntas — `GET /fraud/irregular-behavior`

Ejecuta ambas en paralelo (Neo4j y Mongo a la vez) y agrega `playersInBoth`: los jugadores que aparecen en un grupo de acuerdo de resultados **y** además tienen denuncias convergentes. Es la combinación más fuerte, y es el único lugar donde se cruzan las dos fuentes.

## Carga del grafo: `POST /fraud/projection`

Misma mecánica que la proyección del historial (P6): lee de Mongo las partidas `closed` con scoring `applied`, y hace `MERGE` de `Match`, `Player` y `PLAYED` en lotes de 250 partidas.

`{ "afterId"?: uuid, "limit"?: 10000, "since"?: ISO }` → `{ matches, rows, nextCursor }`

- **Idempotente**: `MERGE` por id (con restricciones de unicidad `Player.id` y `Match.id`); repetirla no duplica nodos ni relaciones.
- **Reanudable** con `nextCursor`.
- Igual que en P6, hoy se dispara a mano o desde el script de carga; engancharla al cierre de P4 es una llamada al final de `scoreIfNeeded`.

## Fallas

P7 es una consulta: no escribe en dos motores a la vez ni necesita compensación.

| Falla                   | Resultado                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| Neo4j caído             | `503 STORAGE_ERROR engine=neo4j` en `match-fixing` e `irregular-behavior`; `cross-reports` sigue funcionando. |
| Mongo caído             | `503 STORAGE_ERROR engine=mongo`.                                                                             |
| Proyección interrumpida | Lo ya cargado es válido; reanudar con `nextCursor` o repetir.                                                 |

Pasos para `x-fail-at`: `fraud.findOpposingPairs`, `fraud.findReportedByMany`, `fraud.findUsernames`, `fraud.upsertMatches`, `playerHistory.listClosedMatches`.

## Preguntas contrafactuales

- **¿Y si el acuerdo de resultados se buscara en Mongo?** Cada consulta sería un autojoin de `matches` con `$unwind` de jugadores: costo proporcional a las partidas de la ventana y cuadrático en el tamaño de la partida, sin índice que ayude al emparejamiento. En el grafo el índice sobre `Match.endedAtMs` acota la ventana y el emparejamiento es recorrer relaciones.
- **¿Y si los reportes estuvieran en Neo4j?** Habría que duplicar la fuente de verdad de las denuncias (estado, asignación a un administrador, sanciones asociadas, todo en Mongo) para responder una pregunta que no es de relaciones sino de conteo en una ventana de tiempo.
- **¿Y si todo fuera un único motor?** O bien Mongo hace el autojoin, o bien Neo4j hace de base de reportes. En ambos casos un motor termina haciendo lo que otro hace mejor, sin ganar consistencia: los reportes y las partidas no se escriben juntos.

## Pruebas

`test/unit/modules/fraudDetection/fraudDetection.test.ts`: reglas puras (beneficiario en cualquiera de los dos lados del par, pocos partidos, empate, umbral de ratio, ventana deslizante, denunciantes repetidos, ráfaga vieja vs. reciente), servicio con un grafo en memoria que replica el Cypher, ventana de tiempo y filtro de modo, cruce de señales, proyección idempotente, API (parámetros, validación 400, falla inyectada).

Verificado contra los motores reales con `pnpm seed:history`: 50.000 partidas (100.000 relaciones `PLAYED`), consulta de acuerdo de resultados en ~650 ms, reportes en ~25 ms. El script planta los casos y sus señuelos:

| Caso plantado                                                             | Resultado esperado                         |
| ------------------------------------------------------------------------- | ------------------------------------------ |
| `seed_player_0` gana siempre a los jugadores 1, 2 y 3 (8, 7 y 6 partidas) | marcado                                    |
| 10 vs 11 con 7-3                                                          | marcado solo con `minBenefitRatio ≤ 0.7`   |
| 12 vs 13, 3 partidas ganadas                                              | no marcado (menos de `minMatches`)         |
| 20 vs 21, 6 partidas ganadas hace 40–50 días                              | no marcado con `days=30`, sí con `days=90` |
| `seed_player_0`: 5 denunciantes en 25 minutos                             | marcado, y aparece en `playersInBoth`      |
| `seed_player_40`: 4 denunciantes en 40 minutos                            | marcado                                    |
| `seed_player_30`: 5 denunciantes en 5 días                                | no marcado                                 |
| `seed_player_31`: 6 denuncias de la misma persona en 10 minutos           | no marcado                                 |

## Limitaciones conocidas

- "Coinciden" se mide como rivales en partidas decididas. Sin equipos modelados (ver `problema4.md`), dos aliados que se pasan ventajas no se detectan.
- Una jerarquía de habilidad real puede parecerse a un acuerdo con `minBenefitRatio=1` y pocas partidas; por eso `minMatches` y el ratio son parámetros y el resultado es una **alerta para revisión**, no una sanción (esa es P8).
- Los reportes "cruzados" se interpretaron como convergencia de denunciantes distintos sobre un mismo jugador. Si la consigna se refería a denuncias recíprocas (A reporta a B y B a A) habría que agregar esa señal a `findReportBursts`.
- La carga del grafo no está enganchada al cierre de P4.
