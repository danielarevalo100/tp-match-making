# Guía de queries: MongoDB, Cassandra y Redis

Guía para practicar las operaciones básicas que pide la cátedra (**agregar, eliminar, modificar, filtrar, ordenar, top N**) sobre las colecciones, tablas y claves reales del proyecto.

## Por qué estos tres motores

| Motor | Por qué es amigable | Cubre bien |
|---|---|---|
| **MongoDB** | Los filtros son objetos JSON y los pasos se leen de izquierda a derecha. Es el más parecido a "SQL con otra sintaxis". | Todo: alta, baja, modificación, filtro, orden, top N |
| **Cassandra** | CQL es casi SQL (`SELECT / INSERT / UPDATE / DELETE / ORDER BY / LIMIT`). Lo difícil son sus reglas, y están resumidas abajo. | Todo, con restricciones |
| **Redis** | Son pocos comandos, de una línea, sin lenguaje de consulta. Los rankings (`ZSET`) dan el "top N" directo. | Alta, baja, modificación, orden, top N |

**Neo4j quedó afuera** a propósito: Cypher es legible, pero exige pensar en grafos (nodos y relaciones), y en este proyecto solo tiene `Player`, `Match` y `PLAYED`. Es el que menos material básico ofrece para practicar.

## Cómo abrir cada terminal

Con el stack levantado (`docker compose up -d`) y los datos de prueba cargados (opción 13 de `consola.cmd`, o `pnpm seed:reset` dentro de `gamingApp`):

- **Opción fácil:** abrir `http://localhost:3002` y elegir el motor. Es una terminal real (`mongosh`, `cqlsh`, `redis-cli`) en el navegador.
- **Desde la terminal local:**

```bash
docker compose exec mongodb mongosh -u gaming_admin -p change_me_local_only --authenticationDatabase admin gaming
docker compose exec cassandra cqlsh -k gaming
docker compose exec redis redis-cli
```

> Practicá tranquilo: si rompés datos, `pnpm seed:reset` (o la opción 13 de la consola) vacía los cuatro motores y los deja como al inicio.

## Los datos de prueba (seed)

- 2000 jugadores: `seed_player_0` … `seed_player_1999`, con `email` `seed_player_N@seed.example`.
- Países y regiones: AR/CL/MX → `LATAM`, BR → `BR`, US → `NA`, DE/ES → `EU`, JP → `ASIA`.
- Modo con datos: `ranked_1v1`. Temporada activa: `2026-S2`.
- 50.000 partidas cerradas, ~300 reportes, 3 administradores (`seed_admin`, `seed_moderator`, `seed_former_moderator`).
- Las sanciones empiezan vacías.
- Los **ids son UUID**, iguales en los cuatro motores: el `_id` de Mongo es el `player_id` de Cassandra y el miembro de los rankings de Redis.

---

# 1. MongoDB (mongosh)

## 1.1 Cómo piensa Mongo

- **Base** → **colección** → **documentos** (JSON/BSON). Una colección es como una tabla, un documento como una fila, pero cada documento puede tener objetos y arreglos anidados.
- Todo se escribe como `db.<coleccion>.<operacion>(<filtro>, <opciones>)`.
- El **filtro** es un objeto: `{ campo: valor }`. Para comparar se usan operadores que empiezan con `$`.
- Los campos anidados se acceden con punto y **entre comillas**: `"ratings.ranked_1v1.mmr"`.

## 1.2 Colecciones del proyecto y sus campos

| Colección | Campos principales |
|---|---|
| `players` | `_id` (string UUID), `username` (minúsculas, 3–32), `email`, `passwordHash`, `registeredAt` (date), `updatedAt` (date), `country` (`"AR"`), `region` (`"LATAM"`), `level` (int), `accountStatus` (`active`/`inactive`/`closed`), `ratings` (objeto por modo: `ratings.<modo>.mmr`, `.gamesPlayed`, `.updatedAt`), `seasonRatings`, `appliedRatingMatches` (array de string) |
| `regions` | `_id` (`"LATAM"`), `name`, `countries` (array de string), `active` (bool) |
| `game_modes` | `_id` (`"ranked_1v1"`), `name`, `minPlayers`, `maxPlayers`, `teams`, `ranked` (bool), `active`, `initialRating`, `matchmaking` (objeto) |
| `seasons` | `_id` (`"2026-S2"`), `name`, `startsAt`, `endsAt` (date), `status` (`scheduled`/`active`/`closed`) |
| `administrators` | `_id`, `username`, `email`, `permissionLevel` (`moderator`/`senior_moderator`/`admin`), `createdAt`, `active` |
| `reports` | `_id`, `reportedPlayerId`, `reporterPlayerId` (puede ser `null`), `matchId`, `reason` (`cheating`/`match_fixing`/`toxicity`/`griefing`/`afk`/`other`), `description`, `createdAt`, `status` (`open`/`assigned`/`resolved`/`dismissed`) |
| `sanctions` | `_id`, `playerId`, `adminId`, `type`, `reason`, `startsAt`, `endsAt` (`null` = permanente), `status` (`active`/`expired`/`revoked`), `createdAt` |
| `matches` | `_id`, `mode`, `region`, `status` (`in_progress`/`closing`/`closed`/`voided`), `players` (array de `{playerId, mmr, enqueuedAt}`), `ratingRange`, `createdAt` |

Tipos que usa el proyecto: `string`, `int`/`long`/`double`, `bool`, `date`, `array`, `object`, `null`.

## 1.3 Moldes

```js
// Alta
db.col.insertOne({ ... })
db.col.insertMany([ {...}, {...} ])

// Consulta
db.col.find(<filtro>, <proyeccion>).sort({campo: 1|-1}).skip(n).limit(n)
db.col.findOne(<filtro>)
db.col.countDocuments(<filtro>)

// Modificación
db.col.updateOne(<filtro>, { $set: { campo: valor } })
db.col.updateMany(<filtro>, { $inc: { campo: 1 } })

// Baja
db.col.deleteOne(<filtro>)
db.col.deleteMany(<filtro>)
```

Operadores más usados:

| Qué | Operador | Ejemplo |
|---|---|---|
| Igual | (directo) | `{ country: "AR" }` |
| Distinto | `$ne` | `{ country: { $ne: "AR" } }` |
| Mayor / menor | `$gt $gte $lt $lte` | `{ level: { $gte: 10 } }` |
| Está en una lista | `$in` / `$nin` | `{ country: { $in: ["AR","CL"] } }` |
| Y / O | `$and` / `$or` | `{ $or: [ {...}, {...} ] }` (varias condiciones en el mismo objeto ya son AND) |
| Existe el campo | `$exists` | `{ avatarUrl: { $exists: false } }` |
| Texto parcial | regex | `{ username: /^seed_player_1/ }` |
| Elemento de array | (directo) | `{ countries: "AR" }` |
| Modificar | `$set $unset $inc $push $pull $addToSet` | `{ $inc: { level: 1 } }` |

Proyección: `{ campo: 1 }` incluye, `{ campo: 0 }` excluye. `_id` viene siempre salvo que pongas `_id: 0`.

## 1.4 Ejemplos para practicar

### Filtrar (SELECT … WHERE)

```js
// Todos los jugadores de Argentina (solo username y level)
db.players.find({ country: "AR" }, { username: 1, level: 1, _id: 0 })

// Un jugador por username
db.players.findOne({ username: "seed_player_0" })

// Región LATAM y nivel 10 o más
db.players.find({ region: "LATAM", level: { $gte: 10 } })

// Argentina o Brasil
db.players.find({ country: { $in: ["AR", "BR"] } })

// Cuántos hay en cada situación puntual
db.players.countDocuments({ accountStatus: "active" })

// Campo anidado: MMR del modo ranked_1v1 mayor a 1100
db.players.find({ "ratings.ranked_1v1.mmr": { $gt: 1100 } })

// Username que empieza con "seed_player_19"
db.players.find({ username: /^seed_player_19/ })

// Reportes de toxicidad todavía abiertos
db.reports.find({ reason: "toxicity", status: "open" })

// Reportes de un rango de fechas
db.reports.find({ createdAt: { $gte: ISODate("2026-10-01"), $lt: ISODate("2026-11-01") } })

// Array: la región cuya lista de países incluye "JP"
db.regions.find({ countries: "JP" })

// Array de objetos: partidas donde participó un jugador
db.matches.find({ "players.playerId": "<id-del-jugador>" })
```

### Ordenar y top N (ORDER BY … LIMIT)

```js
// Top 50 jugadores por MMR en ranked_1v1
db.players.find({}, { username: 1, "ratings.ranked_1v1.mmr": 1, _id: 0 })
  .sort({ "ratings.ranked_1v1.mmr": -1 })
  .limit(50)

// Los 10 jugadores con más nivel (desempate por username)
db.players.find().sort({ level: -1, username: 1 }).limit(10)

// Los 5 reportes más recientes
db.reports.find().sort({ createdAt: -1 }).limit(5)

// Paginación: del 11 al 20
db.players.find().sort({ username: 1 }).skip(10).limit(10)
```

`1` = ascendente, `-1` = descendente.

### Agregar (INSERT)

El esquema es **estricto**: faltan campos obligatorios, sobran campos desconocidos o `username` con mayúsculas → error de validación. Ejemplo válido:

```js
db.players.insertOne({
  _id: "11111111-1111-4111-8111-111111111111",
  username: "practica_uno",
  email: "practica_uno@seed.example",
  passwordHash: "x",
  registeredAt: new Date(),
  updatedAt: new Date(),
  country: "AR",
  region: "LATAM",
  level: 1,
  accountStatus: "active",
  ratings: { ranked_1v1: { mmr: 1000, gamesPlayed: 0, updatedAt: new Date() } }
})
```

Si Mongo se queja de `level` (tipo), usá `NumberInt(1)`.

```js
// Varios a la vez
db.reports.insertMany([
  { _id: "r-practica-1", reportedPlayerId: "11111111-1111-4111-8111-111111111111",
    reporterPlayerId: null, reason: "afk", createdAt: new Date(), status: "open" },
  { _id: "r-practica-2", reportedPlayerId: "11111111-1111-4111-8111-111111111111",
    reporterPlayerId: null, reason: "toxicity", createdAt: new Date(), status: "open" }
])
```

### Modificar (UPDATE)

```js
// Cambiar un campo
db.players.updateOne({ username: "practica_uno" }, { $set: { level: 5, updatedAt: new Date() } })

// Sumar al MMR (campo anidado)
db.players.updateOne({ username: "practica_uno" }, { $inc: { "ratings.ranked_1v1.mmr": 25 } })

// Varios documentos: cerrar todos los reportes de afk
db.reports.updateMany({ reason: "afk" }, { $set: { status: "dismissed" } })

// Agregar / sacar un elemento de un array
db.regions.updateOne({ _id: "OCE" }, { $addToSet: { countries: "FJ" } })
db.regions.updateOne({ _id: "OCE" }, { $pull: { countries: "FJ" } })

// Quitar un campo
db.players.updateOne({ username: "practica_uno" }, { $unset: { avatarUrl: "" } })
```

Sin un operador (`$set`, etc.) el segundo parámetro de `updateOne` da error: no reemplaza el documento por accidente.

### Eliminar (DELETE)

```js
db.reports.deleteMany({ _id: /^r-practica/ })
db.players.deleteOne({ username: "practica_uno" })
```

Regla de oro: **hacé primero el `find` con el mismo filtro**, mirá qué trae y recién después cambiá `find` por `deleteMany`. `deleteMany({})` borra todo.

### Agrupar y contar (aggregate)

Se arma como una cadena de etapas; cada una recibe el resultado de la anterior.

```js
// Cuántos jugadores hay por país, de mayor a menor
db.players.aggregate([
  { $group: { _id: "$country", total: { $sum: 1 } } },
  { $sort: { total: -1 } }
])

// MMR promedio por región, top 3
db.players.aggregate([
  { $group: { _id: "$region", mmrPromedio: { $avg: "$ratings.ranked_1v1.mmr" } } },
  { $sort: { mmrPromedio: -1 } },
  { $limit: 3 }
])

// Reportes por motivo, solo los abiertos
db.reports.aggregate([
  { $match: { status: "open" } },
  { $group: { _id: "$reason", total: { $sum: 1 } } }
])
```

Equivalencias: `$match` = WHERE, `$group` = GROUP BY, `$sort` = ORDER BY, `$limit` = LIMIT, `$project` = lista de columnas.

### Ejemplo con sanciones ("¿qué sanciones están vigentes?")

Una sanción está en vigor si `status = "active"` y `endsAt` es `null` (permanente) o está en el futuro:

```js
db.sanctions.find({
  status: "active",
  $or: [ { endsAt: null }, { endsAt: { $gt: new Date() } } ]
})
```

## 1.5 Ejercicios (Mongo)

1. Listar `username` y `country` de los jugadores de Chile con nivel mayor a 3.
2. Top 20 de jugadores por `level`, de mayor a menor.
3. Insertar un administrador `practica_admin` con `permissionLevel: "moderator"`, pasarlo a `"senior_moderator"` y después borrarlo.
4. Cuántos reportes hay por `reason`, ordenados de mayor a menor.
5. Los 5 reportes `open` más viejos.
6. Poner `accountStatus: "inactive"` a todos los jugadores de Japón y revertirlo.

<details><summary>Soluciones</summary>

```js
// 1
db.players.find({ country: "CL", level: { $gt: 3 } }, { username: 1, country: 1, _id: 0 })
// 2
db.players.find().sort({ level: -1 }).limit(20)
// 3
db.administrators.insertOne({ _id: "22222222-2222-4222-8222-222222222222", username: "practica_admin",
  email: "practica_admin@seed.example", permissionLevel: "moderator", createdAt: new Date(), active: true })
db.administrators.updateOne({ username: "practica_admin" }, { $set: { permissionLevel: "senior_moderator" } })
db.administrators.deleteOne({ username: "practica_admin" })
// 4
db.reports.aggregate([{ $group: { _id: "$reason", total: { $sum: 1 } } }, { $sort: { total: -1 } }])
// 5
db.reports.find({ status: "open" }).sort({ createdAt: 1 }).limit(5)
// 6
db.players.updateMany({ country: "JP" }, { $set: { accountStatus: "inactive" } })
db.players.updateMany({ country: "JP" }, { $set: { accountStatus: "active" } })
```

</details>

---

# 2. Cassandra (cqlsh)

## 2.1 Cómo piensa Cassandra

CQL se parece a SQL, pero **la tabla se diseña para una consulta concreta**. Todo gira alrededor de la `PRIMARY KEY`:

```
PRIMARY KEY ((match_id), ts, event_id)
             └────┬────┘  └────┬────┘
           partition key   clustering columns
```

- **Partition key** (`match_id`): decide en qué nodo/partición vive la fila. Para leer, **hay que darla con `=`**.
- **Clustering columns** (`ts`, `event_id`): ordenan las filas **dentro** de la partición. Se pueden filtrar con rangos (`>=`, `<`) y ordenar, **en el orden en que fueron declaradas**.
- El resto de las columnas son datos normales.

### Reglas que explican casi todos los errores

| Regla | Consecuencia |
|---|---|
| El `WHERE` debe incluir la partition key con `=` | Sin ella: *"Cannot execute this query as it might involve data filtering"* |
| Los rangos solo sobre clustering columns, de izquierda a derecha | No se puede saltear una clustering column |
| `ORDER BY` solo por clustering columns y dentro de una partición | El orden ya viene definido por la tabla (`CLUSTERING ORDER BY`) |
| Filtrar por una columna común exige `ALLOW FILTERING` | Funciona para practicar, pero es un recorrido completo: no se usa en producción |
| No hay `JOIN`, `OR`, `LIKE`, ni subconsultas | Cada tabla responde su propia pregunta |
| `UPDATE` y `DELETE` exigen la clave primaria completa | No se puede "borrar todos los que tengan result = loss" |
| `INSERT` y `UPDATE` son **upsert** | Insertar una clave que existe la **sobrescribe**; no hay error de duplicado |
| No se puede modificar una columna de la clave primaria | Hay que borrar la fila y volver a insertarla |

El keyspace es `gaming`; con `cqlsh -k gaming` no hace falta prefijarlo. Sin eso, `gaming.events_by_match`.

## 2.2 Tablas del proyecto

**`events_by_match`**: eventos de una partida (kills, objetivos, conexiones).

| Columna | Tipo | Rol |
|---|---|---|
| `match_id` | uuid | partition key |
| `ts` | timestamp | clustering (ASC) |
| `event_id` | uuid | clustering (ASC) |
| `event_type` | text | `kill`, `objective`, `disconnect`, `reconnect`, `match_finished` |
| `player_id` | uuid | quién lo hizo |
| `target_player_id` | uuid | la víctima (solo en kills) |
| `detail` | text | |
| `points` | int | |

**`match_history_by_player`**: historial de cada jugador.

| Columna | Tipo | Rol |
|---|---|---|
| `player_id` | uuid | partition key |
| `ended_at` | timestamp | clustering (**DESC**: lo más nuevo primero) |
| `match_id` | uuid | clustering (ASC) |
| `mode`, `region` | text | |
| `result` | text | `win`, `loss`, `draw` |
| `kills`, `deaths`, `objectives`, `score` | int | |
| `mmr_before`, `mmr_after`, `rating_delta` | int | |

Tipos CQL que aparecen: `uuid` (se escribe **sin comillas**), `text` (comillas simples), `timestamp` (texto entre comillas simples: `'2026-10-01'` o `'2026-10-01 14:30:00+0000'`), `int`.

## 2.3 Moldes

```sql
SELECT cols FROM tabla WHERE <partition key> = x [AND <clustering> rango] [ORDER BY clustering] [LIMIT n] [ALLOW FILTERING];
INSERT INTO tabla (cols...) VALUES (...);
UPDATE tabla SET col = valor WHERE <clave primaria completa>;
DELETE [cols] FROM tabla WHERE <clave primaria completa o solo partition key>;
```

Funciones útiles: `uuid()` (genera un uuid), `toTimestamp(now())` (fecha actual), `COUNT(*)`, `SUM`, `AVG`, `MIN`, `MAX` (sobre una partición).

## 2.4 Ejemplos para practicar

### Paso previo: conseguir ids reales

Como no hay `WHERE` sin partición, primero hay que saber una:

```sql
SELECT DISTINCT player_id FROM match_history_by_player LIMIT 5;
SELECT DISTINCT match_id FROM events_by_match LIMIT 5;
```

Copiá un id y reemplazá `<PLAYER_ID>` / `<MATCH_ID>` en los ejemplos. (El `player_id` de `seed_player_0` se obtiene en Mongo: `db.players.findOne({username:"seed_player_0"})._id`.)

### Filtrar

```sql
-- Todo el historial de un jugador
SELECT * FROM match_history_by_player WHERE player_id = <PLAYER_ID>;

-- Columnas puntuales
SELECT ended_at, mode, result, kills, deaths FROM match_history_by_player WHERE player_id = <PLAYER_ID>;

-- Rango sobre la clustering column (partidas desde el 1/10)
SELECT ended_at, result, score FROM match_history_by_player
WHERE player_id = <PLAYER_ID> AND ended_at >= '2026-10-01';

-- Rango cerrado
SELECT ended_at, result FROM match_history_by_player
WHERE player_id = <PLAYER_ID> AND ended_at >= '2026-10-01' AND ended_at < '2026-11-01';

-- Columna común (exige ALLOW FILTERING): solo las victorias
SELECT ended_at, result, kills FROM match_history_by_player
WHERE player_id = <PLAYER_ID> AND result = 'win' ALLOW FILTERING;

-- Eventos de una partida, en orden
SELECT ts, event_type, player_id, points FROM events_by_match WHERE match_id = <MATCH_ID>;

-- Eventos de una partida en un rango de tiempo
SELECT * FROM events_by_match
WHERE match_id = <MATCH_ID> AND ts >= '2026-10-01 00:00:00' AND ts <= '2026-10-31 23:59:59';

-- Solo las kills de esa partida
SELECT ts, player_id, target_player_id FROM events_by_match
WHERE match_id = <MATCH_ID> AND event_type = 'kill' ALLOW FILTERING;
```

### Ordenar y top N

```sql
-- Las últimas 50 partidas de un jugador (ya vienen de la más nueva a la más vieja)
SELECT * FROM match_history_by_player WHERE player_id = <PLAYER_ID> LIMIT 50;

-- Las 10 más antiguas: invertir el orden
SELECT * FROM match_history_by_player WHERE player_id = <PLAYER_ID> ORDER BY ended_at ASC LIMIT 10;

-- Los últimos 5 eventos de una partida
SELECT * FROM events_by_match WHERE match_id = <MATCH_ID> ORDER BY ts DESC LIMIT 5;
```

No se puede `ORDER BY score DESC` (no es clustering). Si necesitás un ranking por `score`, hay que traer las filas y ordenar afuera, o modelar otra tabla: para eso Redis tiene los rankings.

### Contar y agregar (dentro de una partición)

```sql
SELECT COUNT(*) FROM match_history_by_player WHERE player_id = <PLAYER_ID>;
SELECT COUNT(*) FROM match_history_by_player WHERE player_id = <PLAYER_ID> AND result = 'win' ALLOW FILTERING;
SELECT SUM(kills), AVG(kills), MAX(score) FROM match_history_by_player WHERE player_id = <PLAYER_ID>;
```

Evitá `SELECT COUNT(*) FROM tabla` sin `WHERE`: recorre las 50.000 partidas y puede dar timeout.

### Agregar (INSERT)

```sql
INSERT INTO match_history_by_player
  (player_id, ended_at, match_id, mode, region, result, kills, deaths, objectives, score, mmr_before, mmr_after, rating_delta)
VALUES
  (99999999-9999-4999-8999-999999999999, toTimestamp(now()), uuid(), 'ranked_1v1', 'LATAM', 'win', 7, 3, 1, 12, 1000, 1025, 25);

INSERT INTO events_by_match (match_id, ts, event_id, event_type, player_id, points)
VALUES (88888888-8888-4888-8888-888888888888, toTimestamp(now()), uuid(), 'kill',
        99999999-9999-4999-8999-999999999999, 10);
```

Verificar:

```sql
SELECT * FROM match_history_by_player WHERE player_id = 99999999-9999-4999-8999-999999999999;
```

### Modificar (UPDATE)

Hace falta la clave primaria **completa** (`player_id`, `ended_at`, `match_id`). Copiá los valores del `SELECT` anterior:

```sql
UPDATE match_history_by_player
SET result = 'loss', rating_delta = -25, mmr_after = 975
WHERE player_id = 99999999-9999-4999-8999-999999999999
  AND ended_at = '<ended_at copiado>'
  AND match_id = <match_id copiado>;
```

Si te equivocás en la clave, Cassandra **no da error: crea una fila nueva** (upsert). Siempre releé con `SELECT`.

### Eliminar (DELETE)

```sql
-- Una fila (clave completa)
DELETE FROM match_history_by_player
WHERE player_id = 99999999-9999-4999-8999-999999999999
  AND ended_at = '<ended_at copiado>'
  AND match_id = <match_id copiado>;

-- Toda la partición de un jugador (solo la partition key)
DELETE FROM match_history_by_player WHERE player_id = 99999999-9999-4999-8999-999999999999;

-- Una columna de una fila (la deja en null)
DELETE score FROM match_history_by_player WHERE player_id = ... AND ended_at = ... AND match_id = ...;

-- Vaciar la tabla entera
TRUNCATE match_history_by_player;   -- cuidado
```

### Comandos de cqlsh útiles

```sql
DESCRIBE TABLES;
DESCRIBE TABLE match_history_by_player;   -- muestra la clave primaria y el orden
```

## 2.5 Ejercicios (Cassandra)

1. Listar 3 `player_id` distintos del historial.
2. Con uno de ellos, traer sus últimas 10 partidas mostrando `ended_at`, `result` y `score`.
3. Cuántas victorias y cuántas derrotas tiene ese jugador.
4. Sus partidas de octubre de 2026.
5. Insertar una partida de práctica para un `player_id` inventado, modificar su `score` y borrarla.
6. Las primeras 20 kills de una partida de `events_by_match`.

<details><summary>Soluciones</summary>

```sql
-- 1
SELECT DISTINCT player_id FROM match_history_by_player LIMIT 3;
-- 2
SELECT ended_at, result, score FROM match_history_by_player WHERE player_id = <PLAYER_ID> LIMIT 10;
-- 3
SELECT COUNT(*) FROM match_history_by_player WHERE player_id = <PLAYER_ID> AND result = 'win' ALLOW FILTERING;
SELECT COUNT(*) FROM match_history_by_player WHERE player_id = <PLAYER_ID> AND result = 'loss' ALLOW FILTERING;
-- 4
SELECT * FROM match_history_by_player WHERE player_id = <PLAYER_ID>
  AND ended_at >= '2026-10-01' AND ended_at < '2026-11-01';
-- 5: ver los ejemplos de INSERT, UPDATE y DELETE
-- 6
SELECT * FROM events_by_match WHERE match_id = <MATCH_ID> AND event_type = 'kill' LIMIT 20 ALLOW FILTERING;
```

</details>

---

# 3. Redis (redis-cli)

## 3.1 Cómo piensa Redis

Redis es un diccionario **clave → valor**, y el valor tiene un **tipo**. No hay tablas, ni esquemas, ni `WHERE`: **se consulta por el nombre exacto de la clave**, y cada tipo tiene sus propios comandos.

| Tipo | Qué es | Comandos base | Uso en el proyecto |
|---|---|---|---|
| **STRING** | un valor simple | `SET GET DEL INCR EXPIRE TTL` | `player:{id}:active_match` (el `matchId` de la partida actual) |
| **HASH** | un mini-objeto: campo → valor | `HSET HGET HGETALL HDEL HINCRBY` | `mm:ticket:{id}`, `match:{id}`, `match:{id}:scoreboard` |
| **ZSET** | conjunto **ordenado por score** | `ZADD ZRANGE ZSCORE ZRANK ZREM ZINCRBY` | colas `mm:q:…` y rankings `lb:…` |
| **SET** | conjunto sin orden ni repetidos | `SADD SMEMBERS SISMEMBER SREM` | `match:{id}:applied` (eventIds ya aplicados) |

Todo lo guardado son **textos**: los números se guardan como texto y Redis los interpreta al operar (`INCR`, `ZADD`).

## 3.2 Claves del proyecto

| Clave | Tipo | Contenido |
|---|---|---|
| `mm:ticket:{playerId}` | HASH | `ticketId`, `playerId`, `mode`, `region`, `mmr`, `enqueuedAt` |
| `mm:q:{mode}:{region}:rating` | ZSET | jugadores en cola; score = `mmr` |
| `mm:q:{mode}:{region}:wait` | ZSET | jugadores en cola; score = `enqueuedAt` en ms |
| `player:{playerId}:active_match` | STRING | `matchId` de su partida |
| `match:{matchId}` | HASH | `mode`, `region`, `status`, `startedAt`, `players` |
| `match:{matchId}:scoreboard` | HASH | `events`, y por jugador `{playerId}:kills`, `:deaths`, `:score` … |
| `match:{matchId}:applied` | SET | `eventId`s aplicados |
| `lb:{season}:{mode}:global` | ZSET | ranking: miembro = `playerId`, score = MMR |
| `lb:{season}:{mode}:region:{region}` | ZSET | el mismo ranking de una región |
| `lb:{season}:{mode}:members` | HASH | `playerId` → `"revision|region"` |

Con los datos del seed hay rankings reales: `lb:2026-S2:ranked_1v1:global` y `lb:2026-S2:ranked_1v1:region:LATAM` (y `BR`, `NA`, `EU`, `ASIA`). Las **colas, tickets y partidas en vivo empiezan vacías**: se llenan jugando por la API o creándolas a mano como en los ejemplos.

## 3.3 Moldes

```
COMANDO clave [argumentos]
```

Los comandos son de una línea. No hay `WHERE`: para "filtrar" se usan rangos del ZSET, campos de un HASH o patrones de nombre de clave.

## 3.4 Ejemplos para practicar

### Explorar qué hay

```
PING
DBSIZE
SCAN 0 MATCH lb:* COUNT 1000        -- claves que empiezan con lb: (filtrar por nombre)
SCAN 0 MATCH mm:ticket:* COUNT 1000
TYPE lb:2026-S2:ranked_1v1:global   -- zset
EXISTS lb:2026-S2:ranked_1v1:global
TTL match:xxx:closure               -- -1 = no expira, -2 = no existe
```

`KEYS patrón` hace lo mismo pero recorre todo de una vez: sirve en local para practicar, **no en producción**. `SCAN` devuelve un cursor; si no es `0`, se repite con ese cursor.

### Ordenar y top N (ZSET)

Un ZSET ya está ordenado por score. Se lee por posición (`ZRANGE clave desde hasta`, **0 es la primera**; `-1` es la última).

```
-- Top 50 del ranking, de mayor a menor MMR, con su MMR
ZRANGE lb:2026-S2:ranked_1v1:global 0 49 REV WITHSCORES

-- Top 10 de LATAM
ZRANGE lb:2026-S2:ranked_1v1:region:LATAM 0 9 REV WITHSCORES

-- Los 10 con menor MMR
ZRANGE lb:2026-S2:ranked_1v1:global 0 9 WITHSCORES

-- Cuántos jugadores tiene el ranking
ZCARD lb:2026-S2:ranked_1v1:global
```

> Sin `REV` se lee de menor a mayor. En versiones viejas de Redis se usaba `ZREVRANGE clave 0 49 WITHSCORES`, que sigue funcionando.

### Filtrar por score y consultar un jugador

```
-- Jugadores con MMR entre 1100 y 1200
ZRANGE lb:2026-S2:ranked_1v1:global 1100 1200 BYSCORE WITHSCORES

-- Los 10 primeros con MMR >= 1200 (LIMIT desde cantidad)
ZRANGE lb:2026-S2:ranked_1v1:global 1200 +inf BYSCORE LIMIT 0 10 WITHSCORES

-- Cuántos hay entre 1000 y 1100
ZCOUNT lb:2026-S2:ranked_1v1:global 1000 1100

-- MMR de un jugador y su posición (0 = primero)
ZSCORE lb:2026-S2:ranked_1v1:global <PLAYER_ID>
ZREVRANK lb:2026-S2:ranked_1v1:global <PLAYER_ID>

-- Su revisión y región en el ranking (HASH)
HGET lb:2026-S2:ranked_1v1:members <PLAYER_ID>
```

Para obtener un `<PLAYER_ID>`: los miembros del top (`ZRANGE … 0 4 REV`), o en Mongo `db.players.findOne({username:"seed_player_0"})._id`. La posición "humana" es `ZREVRANK + 1`.

### Agregar y modificar

**STRING**

```
SET player:demo-1:active_match match-demo-1
GET player:demo-1:active_match
SET player:demo-1:active_match match-demo-2        -- SET pisa el valor anterior
EXPIRE player:demo-1:active_match 60               -- vence en 60 s
TTL player:demo-1:active_match
```

**HASH** (un ticket de cola)

```
HSET mm:ticket:demo-1 ticketId t-1 playerId demo-1 mode ranked_1v1 region LATAM mmr 1000 enqueuedAt 1760000000000
HGETALL mm:ticket:demo-1
HGET mm:ticket:demo-1 mmr
HMGET mm:ticket:demo-1 mode region
HSET mm:ticket:demo-1 mmr 1050              -- modificar un campo (HSET sobre campo existente lo actualiza)
HINCRBY mm:ticket:demo-1 mmr 25             -- sumar
HEXISTS mm:ticket:demo-1 region
```

**ZSET** (una cola por rating; usamos un modo de práctica para no tocar datos reales)

```
ZADD mm:q:practica:LATAM:rating 1000 demo-1 1150 demo-2 980 demo-3
ZRANGE mm:q:practica:LATAM:rating 0 -1 WITHSCORES      -- todo, de menor a mayor
ZINCRBY mm:q:practica:LATAM:rating 30 demo-3           -- subir el score
ZRANGE mm:q:practica:LATAM:rating 1000 1200 BYSCORE WITHSCORES
```

**SET**

```
SADD match:demo:applied ev-1 ev-2 ev-3
SADD match:demo:applied ev-1                -- ya existía → devuelve 0, no se duplica
SISMEMBER match:demo:applied ev-2
SMEMBERS match:demo:applied
SCARD match:demo:applied
```

### Eliminar

```
DEL player:demo-1:active_match
DEL mm:ticket:demo-1 match:demo:applied
HDEL mm:ticket:demo-1 region                           -- un campo de un HASH
ZREM mm:q:practica:LATAM:rating demo-1                 -- un miembro de un ZSET
ZREMRANGEBYSCORE mm:q:practica:LATAM:rating -inf 1000  -- por rango de score
SREM match:demo:applied ev-1
```

Limpieza de la práctica: `DEL mm:ticket:demo-1 mm:q:practica:LATAM:rating match:demo:applied player:demo-1:active_match`.

### Cosas que Redis **no** hace

- No filtra por el contenido de un valor (no existe "los tickets con mmr > 1000"). Por eso el proyecto tiene la cola `…:rating` como ZSET: el filtro por MMR es un `ZRANGE … BYSCORE`.
- No hay `JOIN` ni agrupar. Para nombres o países del ranking hay que ir a Mongo con los ids.
- `FLUSHDB` **borra todo** lo que hay en la base. No lo uses si no querés recargar el seed.

## 3.5 Ejercicios (Redis)

1. Mostrar el top 20 global de `ranked_1v1` en la temporada `2026-S2`.
2. Cuántos jugadores tienen entre 1000 y 1100 de MMR.
3. Mostrar el top 5 de la región `EU`.
4. Elegir un jugador del top 5 y obtener su MMR y su posición.
5. Crear un ticket de práctica (HASH) con `HSET`, subirle el `mmr` en 50 y borrarlo.
6. Crear una cola ZSET con 4 jugadores, ver quién tiene el MMR más alto y quitar al más bajo.

<details><summary>Soluciones</summary>

```
# 1
ZRANGE lb:2026-S2:ranked_1v1:global 0 19 REV WITHSCORES
# 2
ZCOUNT lb:2026-S2:ranked_1v1:global 1000 1100
# 3
ZRANGE lb:2026-S2:ranked_1v1:region:EU 0 4 REV WITHSCORES
# 4
ZSCORE lb:2026-S2:ranked_1v1:global <PLAYER_ID>
ZREVRANK lb:2026-S2:ranked_1v1:global <PLAYER_ID>
# 5
HSET mm:ticket:demo-2 mode ranked_1v1 region LATAM mmr 1000
HINCRBY mm:ticket:demo-2 mmr 50
DEL mm:ticket:demo-2
# 6
ZADD mm:q:practica:LATAM:rating 900 a 1200 b 1100 c 950 d
ZRANGE mm:q:practica:LATAM:rating 0 0 REV WITHSCORES
ZPOPMIN mm:q:practica:LATAM:rating
```

</details>

---

# 4. Tabla comparativa

| Operación | MongoDB | Cassandra | Redis |
|---|---|---|---|
| **Agregar** | `insertOne({...})` | `INSERT INTO t (...) VALUES (...)` | `SET` / `HSET` / `ZADD` / `SADD` |
| **Consultar todo** | `find()` | `SELECT * FROM t LIMIT n` | `GET` / `HGETALL` / `ZRANGE k 0 -1` / `SMEMBERS` |
| **Filtrar** | `find({campo: valor})`, `$gt`, `$in`, `$or` | `WHERE partición = x [AND clustering rango]`, o `ALLOW FILTERING` | `ZRANGE … BYSCORE`, `HGET`, `SCAN MATCH` |
| **Ordenar** | `.sort({campo: 1/-1})` | `ORDER BY` (solo clustering, dentro de una partición) | automático en ZSET; `REV` para invertir |
| **Top N** | `.sort(...).limit(N)` | `... LIMIT N` (orden de la tabla) | `ZRANGE k 0 N-1 REV WITHSCORES` |
| **Modificar** | `updateOne(filtro, {$set: {...}})` | `UPDATE t SET ... WHERE clave completa` | `SET` / `HSET` / `HINCRBY` / `ZINCRBY` |
| **Eliminar** | `deleteOne(filtro)` / `deleteMany(filtro)` | `DELETE FROM t WHERE clave` | `DEL` / `HDEL` / `ZREM` / `SREM` |
| **Contar** | `countDocuments(filtro)` | `SELECT COUNT(*) ... WHERE partición` | `ZCARD` / `ZCOUNT` / `SCARD` / `DBSIZE` |
| **Agrupar** | `aggregate([{$group}])` | no (solo agregados dentro de una partición) | no |
| **Si insertás algo que existe** | error por `_id` repetido | lo sobrescribe | lo sobrescribe |

# 5. Errores típicos y qué significan

| Mensaje | Motor | Causa y arreglo |
|---|---|---|
| `Document failed validation` | Mongo | Falta un campo obligatorio, sobra uno no permitido o el tipo no coincide (ver 1.2). Revisá el `$jsonSchema` en `infra/mongo/init.js`. |
| `E11000 duplicate key` | Mongo | `_id`, `username` o `email` repetido (índices únicos). |
| `Cannot execute this query as it might involve data filtering` | Cassandra | Te falta la partition key o filtrás por una columna común. Agregá la partición con `=` o usá `ALLOW FILTERING` para practicar. |
| `PRIMARY KEY column "x" cannot be restricted as preceding column "y" is not restricted` | Cassandra | Saltaste una clustering column. Respetá el orden de la clave. |
| `ORDER BY is only supported when the partition key is restricted` | Cassandra | Falta el `player_id` / `match_id` con `=`. |
| `Invalid STRING constant … for "player_id" of type uuid` | Cassandra | El uuid va **sin comillas**. |
| `WRONGTYPE Operation against a key holding the wrong kind of value` | Redis | Usaste el comando de otro tipo (ej. `GET` sobre un HASH). Verificá con `TYPE clave`. |
| `(nil)` / `(empty array)` / `0` | Redis | La clave no existe: revisá el nombre exacto (las colas están vacías hasta que alguien entra). |
