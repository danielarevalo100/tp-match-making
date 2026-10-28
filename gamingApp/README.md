# Gaming app

Application layer REST API for the gaming platform. Every business process lives in a module under `src/api/modules`, and dependencies are wired by hand in `src/composition`.

## Layout

```text
src/
|-- server.ts
|-- config.ts
|-- composition/
|   |-- createContainer.ts
|   `-- <module>Composition.ts
|-- shared/
|   |-- errors.ts
|   |-- password.ts
|   |-- requestContext.ts
|   `-- storageKeys.ts
|-- infrastructure/
|   |-- baseAdapter.ts
|   |-- cassandra/
|   |   |-- cassandraConnection.ts
|   |   `-- baseCassandraAdapter.ts
|   |-- mongo/
|   |   |-- mongoConnection.ts
|   |   `-- baseMongoAdapter.ts
|   |-- neo4j/
|   |   |-- neo4jConnection.ts
|   |   `-- baseNeo4jAdapter.ts
|   `-- redis/
|       |-- redisConnection.ts
|       `-- baseRedisAdapter.ts
`-- api/
    |-- app.ts
    |-- errorHandler.ts
    |-- middlewares/
    `-- modules/
        `-- <module>/
            |-- business/
            |   |-- models/
            |   |-- ports/
            |   `-- services/
            |-- infrastructure/
            |   |-- adapters/
            |   `-- mappers/
            `-- presentation/
                |-- controllers/
                |-- routers/
                `-- schemas/
test/
|-- support/
|   `-- inMemory/
|-- unit/
`-- integration/
```

- **Service**: business logic of the module. It depends only on the interfaces declared in `ports/`.
- **Adapter**: implements a port against one database. Database adapters extend the base adapter for their engine (`BaseMongoAdapter`, `BaseRedisAdapter`), which extends `BaseAdapter`.
- **Mapper**: converts between database documents and models, and maps driver errors to business errors.
- **Controller**: validates the request with the module schemas, calls the service and writes the response.
- **Composition**: each `<module>Composition.ts` builds the adapters, service, controller and router of one module and returns the path where it is mounted.

Files and folders use camelCase.

## Base adapter

Every adapter method runs through `BaseAdapter.run(step, operation)`:

- if the request asked to fail at `step`, it throws `InjectedFailureError` before touching the database;
- driver errors are wrapped in `StorageError` with the engine and step;
- business errors are rethrown unchanged.

## Fault injection

Send the `x-fail-at` header with the step name to force a failure at that step:

```bash
curl -X POST http://localhost:3001/players \
  -H "content-type: application/json" \
  -H "x-fail-at: players.create" \
  -d '{"username":"player_one","email":"player@example.com","password":"a-secure-password","country":"AR"}'
```

The response is `500` with `{"error":"INJECTED_FAILURE","step":"players.create"}`.

## Modules

### players

| Method  | Path                              | Purpose                               |
| ------- | --------------------------------- | ------------------------------------- |
| `POST`  | `/players`                        | Register a player                     |
| `GET`   | `/players/:playerId`              | Get a player                          |
| `GET`   | `/players?limit=20&cursor=<uuid>` | List players with cursor pagination   |
| `PATCH` | `/players/:playerId`              | Update profile fields                 |
| `PATCH` | `/players/:playerId/status`       | Set `active`, `inactive`, or `closed` |

Usernames and emails are trimmed and converted to lowercase before use. Countries are stored as uppercase ISO alpha-2 codes. Passwords are hashed with Node.js `scrypt` and never returned by the API.

The API does not implement authentication or authorization. Before exposing it outside the local development network, protect profile updates and restrict account-status changes to the appropriate player or administrator roles.

### matchmaking

Matchmaking queue entry (problem 1). MongoDB is only read to check eligibility; the live queue lives in Redis.

| Method   | Path                           | Purpose                       |
| -------- | ------------------------------ | ----------------------------- |
| `POST`   | `/matchmaking/queue`           | Join a queue                  |
| `GET`    | `/matchmaking/queue/:playerId` | Get the player's queue ticket |
| `DELETE` | `/matchmaking/queue/:playerId` | Leave the queue               |

`POST /matchmaking/queue` body: `{ "playerId": uuid, "mode": "ranked_1v1", "region"?: "LATAM", "ticketId"?: uuid }`. `region` defaults to the player's region and `ticketId` is the idempotency key, generated when omitted.

| Result                                   | HTTP | `error`                                  |
| ---------------------------------------- | ---- | ---------------------------------------- |
| Joined                                   | 201  |                                          |
| Same `ticketId` retried (no duplicate)   | 200  |                                          |
| Player does not exist                    | 404  | `PLAYER_NOT_FOUND`                       |
| Account not `active`                     | 422  | `ACCOUNT_NOT_ACTIVE`                     |
| Mode inactive or unknown, region unknown | 422  | `MODE_NOT_AVAILABLE`, `REGION_NOT_FOUND` |
| Sanction in force                        | 403  | `PLAYER_SANCTIONED`                      |
| Already in a queue (other `ticketId`)    | 409  | `ALREADY_IN_QUEUE`                       |
| Active match                             | 409  | `ALREADY_IN_MATCH`                       |
| Redis or MongoDB unavailable             | 503  | `STORAGE_ERROR`                          |

1. **MongoDB (read only):** the player exists and is `active`, the mode and region are active, and there is no sanction in force (`status = active`, `startsAt <= now`, `endsAt` null or in the future). The rating is `players.ratings.<mode>.mmr`, falling back to `game_modes.initialRating`.
2. **Redis (one atomic Lua script):** if a ticket exists, the request is a replay (same `ticketId`) or `ALREADY_IN_QUEUE`; otherwise, if `player:{id}:active_match` exists, `ALREADY_IN_MATCH`; otherwise the ticket is written and the player is added to `mm:q:{mode}:{region}:rating` and `:wait`. Checking and writing in one step means concurrent requests for a player cannot leave them in two queues.

Key conventions are documented in [`infra/redis/README.md`](../infra/redis/README.md). The sanction check has a small race window with a sanction created right after it; problem 8 closes it by removing the player from the queue.

Fault injection steps: `matchmaking.findPlayer`, `matchmaking.findActiveMode`, `matchmaking.isActiveRegion`, `matchmaking.findSanctionInForce`, `matchmaking.enqueue`, `matchmaking.findTicket`, `matchmaking.leave`.

### matchEvents

In-match events and live scoreboard (problem 3). Events are appended to Cassandra (`events_by_match`) and applied to a scoreboard in Redis; both are written for every event, log first. See [`docs/problema3.md`](../docs/problema3.md).

| Method | Path                                     | Purpose                                                                 |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/matches/:matchId/events`               | Record an event (idempotent by `eventId`)                               |
| `GET`  | `/matches/:matchId/events`               | Read the log in time order (`fromTsMs`, `toTsMs`, `limit`, `pageState`) |
| `GET`  | `/matches/:matchId/scoreboard`           | Live scoreboard                                                         |
| `POST` | `/matches/:matchId/scoreboard/reconcile` | Apply to the scoreboard any logged event it is missing                  |

Fault injection steps: `matchEvents.findLiveMatch`, `matchEvents.appendEvent`, `matchEvents.applyScoreboard`, `matchEvents.listEvents`, `matchEvents.findScoreboard`.

### matchClosure

Match closure and eventual scoring (problem 4). The workflow prepares `closing` in Redis and MongoDB, commits the immutable `match_finished` event in Cassandra, releases players atomically, and then rebuilds the authoritative score from Cassandra. See [`docs/problema4.md`](../docs/problema4.md).

| Method | Path                       | Purpose                                                 |
| ------ | -------------------------- | ------------------------------------------------------- |
| `POST` | `/matches/:matchId/finish` | Idempotently close, release players and attempt scoring |

Lifecycle and scoring are independent: a response may contain `status=closed`, `playersReleased=true`, and `scoringStatus=failed`. Repeating the same payload retries scoring without duplicating the fixed rating delta (`win +25`, `loss -25`, `draw 0`).

After scoring is `applied`, the match's season standings are published to the Redis leaderboard (problem 5) as the last step, so the leaderboard can lag behind the rating but never get ahead of it. `leaderboardStatus` is `published`, `not_ranked` (unranked mode or no active season) or `pending`; the response is `200` only when scoring is applied and the leaderboard is not pending, otherwise `202`.

Fault injection steps: `matchClosure.findMatch`, `matchClosure.beginClosing`, `matchClosure.prepareMongo`, `matchClosure.appendFinished`, `matchClosure.releasePlayers`, `matchClosure.markClosed`, `matchClosure.beginScoring`, `matchClosure.findLeaderboardSeason`, `matchClosure.listEvents`, `matchClosure.applyRating`, `matchClosure.completeScoring`, `matchClosure.findStandings`, `leaderboard.publish`, `matchClosure.markLeaderboard`.

### leaderboards

Leaderboard queries (problem 5). Redis sorted sets hold the order and positions per season, mode and scope; MongoDB validates the season, mode and region and adds usernames, countries and season games. See [`docs/problema5.md`](../docs/problema5.md).

| Method | Path                                                           | Purpose                                                                            |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/leaderboards/:mode/:seasonId?region=LATAM`                   | Top 100, global or regional                                                        |
| `GET`  | `/leaderboards/:mode/:seasonId/players/:playerId?region=LATAM` | Player position with five players above and below                                  |
| `POST` | `/leaderboards/:mode/:seasonId/rebuild`                        | Republish every MongoDB standing to Redis and drop members MongoDB no longer ranks |

Errors: `LEADERBOARD_NOT_FOUND` (404, unknown season, mode or region), `MODE_NOT_RANKED` (422), `PLAYER_NOT_RANKED` (404).

Fault injection steps: `leaderboard.findSeason`, `leaderboard.findMode`, `leaderboard.findRegion`, `leaderboard.top`, `leaderboard.around`, `leaderboard.findPlayers`, `leaderboard.listStandings`, `leaderboard.findStandings`, `leaderboard.listMembers`, `leaderboard.remove`, `leaderboard.publish`.

### playerHistory

Player history and statistics (problem 6, read-only). The last 50 matches and the statistics of the week, month and active season come from one Cassandra partition per player (`match_history_by_player`); MongoDB provides the player and the season calendar. Statistics are derived on every read, never stored. See [`docs/problema6.md`](../docs/problema6.md).

| Method | Path                         | Purpose                                                                           |
| ------ | ---------------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/history/players/:playerId` | Last 50 matches, and `week` / `month` / `season` statistics with rating evolution |
| `POST` | `/history/projection`        | Idempotently copy closed matches (MongoDB) into the history (Cassandra)           |

Fault injection steps: `playerHistory.findPlayer`, `playerHistory.findActiveSeason`, `playerHistory.findLatest`, `playerHistory.findSince`, `playerHistory.listClosedMatches`, `playerHistory.appendRows`.

### fraudDetection

Irregular behavior detection (problem 7, read-only). Match fixing is found in a Neo4j co-participation graph (`(:Player)-[:PLAYED]->(:Match)`); converging reports come from MongoDB. See [`docs/problema7.md`](../docs/problema7.md).

| Method | Path                        | Purpose                                                                                                |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET`  | `/fraud/match-fixing`       | Players who keep beating the same opponents (`days`, `minMatches`, `minBenefitRatio`, `mode`, `limit`) |
| `GET`  | `/fraud/cross-reports`      | Players reported by several different people in a short time (`days`, `minReporters`, `windowMinutes`) |
| `GET`  | `/fraud/irregular-behavior` | Both signals, and the players present in both                                                          |
| `POST` | `/fraud/projection`         | Idempotently load closed matches (MongoDB) into the graph (Neo4j)                                      |

Fault injection steps: `fraud.findOpposingPairs`, `fraud.findReportedByMany`, `fraud.findUsernames`, `fraud.upsertMatches`.

Both projections read the matches that problem 4 leaves `closed` with `scoringStatus=applied`, and both accept `{ afterId?, limit?, since? }` and return `{ matches, rows, nextCursor }` so they can be resumed.

### sanctions

Sanction with result reversal and the player profile (problem 8). The sanction is registered in MongoDB first and is in force whatever happens next. The reversal then only moves forward, recording each step in a journal inside the sanction: the player leaves the queue (Redis); the affected players are held in their leaderboards (Redis); each listed match is voided and its rating deltas reverted (MongoDB), and its rows are removed from the history (Cassandra) and from the graph (Neo4j); finally one Lua script per board publishes every held player and drops the hold. Until then the boards show none of the reversal, so a failure never leaves results partially voided. See [`docs/problema8.md`](../docs/problema8.md).

| Method | Path                             | Purpose                                                                        |
| ------ | -------------------------------- | ------------------------------------------------------------------------------ |
| `POST` | `/sanctions`                     | Register the sanction and void the listed matches (idempotent by `sanctionId`) |
| `GET`  | `/sanctions/:sanctionId`         | The sanction and its reversal journal                                          |
| `POST` | `/sanctions/:sanctionId/resume`  | Continue an incomplete reversal from its journal                               |
| `GET`  | `/profiles/:playerId?matches=10` | Profile, ratings, leaderboard positions, sanctions and latest matches          |

`POST /sanctions` answers `201` (created, reversal completed), `200` (same `sanctionId` repeated) or `202` (sanction registered, reversal incomplete: retry or resume). Errors: `ADMINISTRATOR_NOT_FOUND` (404), `ADMINISTRATOR_NOT_ACTIVE` (422), `INVALID_SANCTION_REPORT` (422), `MATCH_NOT_REVERSIBLE` (422), `SANCTION_CONFLICT` (409), `SANCTION_NOT_FOUND` (404).

Fault injection steps: `sanctions.findSanction`, `sanctions.findPlayer`, `sanctions.findAdministrator`, `sanctions.findReport`, `sanctions.findMatches`, `sanctions.insertSanction`, `matchmaking.leave`, `sanctions.markStep`, `sanctions.findSeasonCatalog`, `leaderboard.hold`, `sanctions.voidMatch`, `sanctions.revertRating`, `sanctions.deleteHistory`, `sanctions.deleteGraph`, `sanctions.markMatchReverted`, `sanctions.findStandings`, `leaderboard.release`, `leaderboard.publish`, `sanctions.completeReversal`, `profile.findPlayer`, `profile.findActiveSeason`, `profile.findSanctions`.

### Test data for the eight problems

With the stack running and the schema applied, from `gamingApp` (needs a `.env`, see below):

```bash
pnpm seed          # load; running it again does not duplicate anything
pnpm seed:reset    # empty the four engines first, then load: always the same starting point
```

The demo console (option 11) runs the same `--reset` load without needing a `.env`.

It writes 3 administrators (one inactive), 2,000 players, 50,000 closed matches and about 320 reports to MongoDB with deterministic ids. Players carry their `ranked_1v1` rating, their standing in the active season (`seasonRatings`) and the matches already applied to it, exactly as problem 4 leaves them. Then the same services the API exposes load the other engines: the history projection (100,000 rows in Cassandra), the graph projection (100,000 `PLAYED` relationships in Neo4j) and the leaderboard rebuild (Redis). It plants the cases listed in `docs/problema7.md` and prints a ready `POST /sanctions` body for problem 8 (the ring leader, three of the fixed matches and the report that cites one). The reset keeps the catalogs (regions, game modes, seasons), the Cassandra tables and the Neo4j constraints. Override with `SEED_PLAYERS`, `SEED_MATCHES`, `SEED_REPORTS`, `SEED_NOW` and `SEED_RESET=1`.

## Shared endpoints

| Method | Path      | Purpose                                       |
| ------ | --------- | --------------------------------------------- |
| `GET`  | `/health` | Process liveness                              |
| `GET`  | `/ready`  | MongoDB, Cassandra, Neo4j and Redis readiness |
| Method | Path      | Purpose                                       |
| ------ | --------- | --------------------------------------        |

## Local development

From the repository root, copy `.env.example` to `.env` and ensure the MongoDB, Redis, Cassandra and Neo4j containers and the schema are running (Cassandra takes about a minute to become healthy, and the app needs its keyspace, so apply the schema before starting the app):

```bash
docker compose up -d mongodb redis cassandra neo4j
./scripts/initialize-infrastructure.sh
```

On PowerShell, run `.\scripts\initialize-infrastructure.ps1` instead.

The project uses pnpm, pinned in the `packageManager` field of `package.json`. Enable it once with Corepack:

```bash
corepack enable
```

Then, from `gamingApp`, copy `.env.example` to `.env`. Use `127.0.0.1` rather than `localhost` in `REDIS_URL`: on some Windows and Docker Desktop setups `localhost` resolves to `::1` and the connection is reset. `NEO4J_PASSWORD` must be the password of `NEO4J_AUTH` in the root `.env`.

```bash
pnpm install
pnpm dev
```

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

The integration tests in `test/integration` are skipped unless `REDIS_URL` is set (the match events ones also need `CASSANDRA_CONTACT_POINTS`, and the MongoDB standings ones need `MONGODB_URI` with the schema applied). They use throwaway keys and rows and clean up after themselves:

```bash
REDIS_URL=redis://127.0.0.1:6379 CASSANDRA_CONTACT_POINTS=127.0.0.1 MONGODB_URI="mongodb://gaming_admin:change_me_local_only@127.0.0.1:27017/?authSource=admin" pnpm test
```

`pnpm lint:fix` and `pnpm format` apply automatic fixes. ESLint uses `typescript-eslint` with type-checked rules and `eslint-config-prettier`, so formatting is left to Prettier.

## Demo

`scripts/demo-problem-1.sh` (or `.ps1`) at the repository root registers a throwaway player and walks through problem 1: success, idempotent retry, second queue, active match, sanction and a concurrent burst. It needs the Compose stack running.

If player registration fails with "Document failed validation", the MongoDB volume was created with an older schema: reapply it with `scripts/initialize-infrastructure.sh` (or `.ps1`).

`scripts/demo-problem-3.mjs` simulates 100 simultaneous matches (`node scripts/demo-problem-3.mjs`), checks the scoreboards and the Cassandra log, and provokes the failure scenarios. See `docs/problema3.md`.

`scripts/demo-problem-5.mjs` seeds 50,000 ranked players into MongoDB, rebuilds the Redis leaderboards, checks the top 100 and a player's neighbours against MongoDB, measures latency, compares Redis `ZREVRANK` with a MongoDB count, and simulates losing the Redis boards (`node scripts/demo-problem-5.mjs`). It uses the drivers installed in `gamingApp`. See `docs/problema5.md`.

`scripts/demo-problem-8.mjs` seeds three players and three closed ranked matches as problem 4 leaves them, sanctions the cheater with a failure injected half way (the leaderboard keeps its previous state), shows that a rebuild cannot publish the held players, resumes the reversal and checks every engine, then covers the idempotent retry, a failure before the sanction is registered, an invalid match and the matchmaking block (`node scripts/demo-problem-8.mjs`). It needs the whole Compose stack. See `docs/problema8.md`.

## Example registration

```bash
curl -X POST http://localhost:3001/players \
  -H "content-type: application/json" \
  -d '{"username":"player_one","email":"player@example.com","password":"a-secure-password","country":"AR","birthDate":"1995-04-12"}'
```
