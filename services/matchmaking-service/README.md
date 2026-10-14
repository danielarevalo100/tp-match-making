# matchmaking-service

Matchmaking queue entry (**problem 1**). MongoDB is only read (eligibility); the live queue lives in Redis.

## API

`POST /matchmaking/queue` — body `{ "playerId": uuid, "mode": "ranked_1v1", "region"?: "LATAM", "ticketId"?: uuid }`.
`region` defaults to the player's region; `ticketId` is the idempotency key (generated when omitted).

| Result | HTTP | `error` |
| --- | --- | --- |
| Joined | 201 | — |
| Same `ticketId` retried (no duplicate) | 200 | — |
| Player does not exist | 404 | `PLAYER_NOT_FOUND` |
| Account not `active` | 422 | `ACCOUNT_NOT_ACTIVE` |
| Mode inactive/unknown, region unknown | 422 | `MODE_NOT_AVAILABLE`, `REGION_NOT_FOUND` |
| Sanction in force | 403 | `PLAYER_SANCTIONED` |
| Already in a queue (other `ticketId`) | 409 | `ALREADY_IN_QUEUE` |
| Active match | 409 | `ALREADY_IN_MATCH` |
| Redis unavailable | 503 | `QUEUE_UNAVAILABLE` |

`GET /matchmaking/queue/:playerId` returns the ticket; `DELETE /matchmaking/queue/:playerId` leaves the queue (204). `/health` and `/ready` (checks MongoDB and Redis) as in the other services.

## How it works

1. **MongoDB (read only):** player exists and is `active`; mode is active; region is active; no sanction in force (`status = active`, `startsAt <= now`, `endsAt` null or in the future); rating = `players.ratings.<mode>.mmr`, falling back to `game_modes.initialRating`.
2. **Redis (one atomic Lua script, `src/infrastructure/redis/redis-scripts.ts`):** if a ticket exists → replay (same `ticketId`) or `ALREADY_IN_QUEUE`; else if `player:{id}:active_match` exists → `ALREADY_IN_MATCH`; else write `mm:ticket:{id}` and add the player to `mm:q:{mode}:{region}:rating` and `:wait`. Check and write are one step, so concurrent requests for a player cannot leave them in two queues.

Key conventions are documented in [`infra/redis/README.md`](../../infra/redis/README.md). The sanction check has a small race window with a sanction created right after it; problem 8 closes it by removing the player from the queue.

Code layout follows `players-service`: `presentation/http` → `application/use-cases` → `domain` interfaces ← `infrastructure/{mongodb,redis}`, wired in `composition/create-container.ts`.

## Run

With the Compose stack: `docker compose up -d --build matchmaking-service` (host port `MATCHMAKING_SERVICE_PORT`, default 3002).

Locally: copy `.env.example` to `.env`, `npm ci`, `npm run dev`. Use `127.0.0.1` rather than `localhost` for Redis (see `.env.example`).

## Tests

```bash
npm test                                    # unit tests, in-memory repositories
REDIS_URL=redis://127.0.0.1:6379 npm test   # also runs the real-Redis integration tests
```

The integration tests (atomicity, idempotency, 50 concurrent requests for one player) use throwaway keys and clean up after themselves.

## Demo

`scripts/demo-problem-1.sh` (or `.ps1`) at the repo root registers a throwaway player and walks through success, idempotent retry, second queue, active match, sanction and a concurrent burst. It needs `players-service` and `matchmaking-service` running.

If player registration fails with "Document failed validation", the MongoDB volume was created with an older schema: reapply it with `scripts/initialize-infrastructure.sh` (or `.ps1`).
