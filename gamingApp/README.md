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

| Method | Path                                       | Purpose                                              |
| ------ | ------------------------------------------ | ---------------------------------------------------- |
| `POST` | `/matches/:matchId/events`                 | Record an event (idempotent by `eventId`)            |
| `GET`  | `/matches/:matchId/events`                 | Read the log in time order (`fromTsMs`, `toTsMs`, `limit`, `pageState`) |
| `GET`  | `/matches/:matchId/scoreboard`             | Live scoreboard                                      |
| `POST` | `/matches/:matchId/scoreboard/reconcile`   | Apply to the scoreboard any logged event it is missing |

Fault injection steps: `matchEvents.findLiveMatch`, `matchEvents.appendEvent`, `matchEvents.applyScoreboard`, `matchEvents.listEvents`, `matchEvents.findScoreboard`.

## Shared endpoints

| Method | Path      | Purpose                     |
| ------ | --------- | --------------------------- |
| `GET`  | `/health` | Process liveness            |
| `GET`  | `/ready`  | MongoDB, Cassandra and Redis readiness |

## Local development

From the repository root, copy `.env.example` to `.env` and ensure the MongoDB, Redis and Cassandra containers and the schema are running (Cassandra takes about a minute to become healthy, and the app needs its keyspace, so apply the schema before starting the app):

```bash
docker compose up -d mongodb redis cassandra
./scripts/initialize-infrastructure.sh
```

On PowerShell, run `.\scripts\initialize-infrastructure.ps1` instead.

The project uses pnpm, pinned in the `packageManager` field of `package.json`. Enable it once with Corepack:

```bash
corepack enable
```

Then, from `gamingApp`, copy `.env.example` to `.env`. Use `127.0.0.1` rather than `localhost` in `REDIS_URL`: on some Windows and Docker Desktop setups `localhost` resolves to `::1` and the connection is reset.

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

The integration tests in `test/integration` are skipped unless `REDIS_URL` is set (the match events ones also need `CASSANDRA_CONTACT_POINTS`). They use throwaway keys and rows and clean up after themselves:

```bash
REDIS_URL=redis://127.0.0.1:6379 CASSANDRA_CONTACT_POINTS=127.0.0.1 pnpm test
```

`pnpm lint:fix` and `pnpm format` apply automatic fixes. ESLint uses `typescript-eslint` with type-checked rules and `eslint-config-prettier`, so formatting is left to Prettier.

## Demo

`scripts/demo-problem-1.sh` (or `.ps1`) at the repository root registers a throwaway player and walks through problem 1: success, idempotent retry, second queue, active match, sanction and a concurrent burst. It needs the Compose stack running.

If player registration fails with "Document failed validation", the MongoDB volume was created with an older schema: reapply it with `scripts/initialize-infrastructure.sh` (or `.ps1`).

`scripts/demo-problem-3.mjs` simulates 100 simultaneous matches (`node scripts/demo-problem-3.mjs`), checks the scoreboards and the Cassandra log, and provokes the failure scenarios. See `docs/problema3.md`.

## Example registration

```bash
curl -X POST http://localhost:3001/players \
  -H "content-type: application/json" \
  -d '{"username":"player_one","email":"player@example.com","password":"a-secure-password","country":"AR","birthDate":"1995-04-12"}'
```
