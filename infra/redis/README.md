# Redis infrastructure

Redis does not require a schema initialization script. Its local-development configuration currently lives directly in the root `docker-compose.yml`:

- append-only persistence is enabled with `--appendonly yes`;
- data is stored in the named `redis_data` volume;
- readiness is checked with `redis-cli ping`;
- containers on `gaming-network` connect to `redis:6379`;
- host tools connect to `localhost` and `REDIS_PORT` from the root `.env`.

## Verify the connection

With the Compose stack running:

```bash
docker compose exec redis redis-cli ping
```

The expected response is `PONG`.

To inspect persistence information:

```bash
docker compose exec redis redis-cli INFO persistence
```

## Key conventions

Redis holds live state only; MongoDB stays the source of truth. `{playerId}` is the shared player UUID.

| Key | Type | Meaning | Written by | Expiry |
| --- | --- | --- | --- | --- |
| `mm:ticket:{playerId}` | HASH | The player's queue ticket: `ticketId`, `playerId`, `mode`, `region`, `mmr`, `enqueuedAt` (ms). Its existence guarantees at most one queue per player. | gaming-app `matchmaking` module (problem 1); removed on leaving or when a match forms (problem 2) | none |
| `mm:q:{mode}:{region}:rating` | ZSET | Queued players by `mmr` (score), used to find similar ratings. | problem 1 | none |
| `mm:q:{mode}:{region}:wait` | ZSET | Queued players by `enqueuedAt` in ms (score), used to find the longest waiting and widen the range. | problem 1 | none |
| `player:{playerId}:active_match` | STRING | `matchId` of the match the player is in (or being formed into). | created by problem 2 (reserve), removed by problem 4 or by the problem 2 compensation | none |
| `mm:formation:{matchId}` | HASH | Journal of a match formation: `status` (`reserved` → `committed` / `rolled_back`), `tickets` (JSON snapshot of the reserved tickets, immutable), `createdAt`, and `abandoned:{playerId}` for reserved players who left. | problem 2 | none (kept as audit of the saga) |
| `mm:formations` | ZSET | Formations still `reserved`, scored by creation time; used by `POST /matchmaking/matches/recover` to compensate stale ones. | problem 2 | removed on commit / rollback |
| `match:{matchId}` | HASH | Live match: `matchId`, `mode`, `region`, `status=in_progress`, `startedAt`, `players` (csv). Base for problem 3. | problem 2 (commit) | removed by problem 4 |

### Problem 2: match formation saga

`POST /matchmaking/matches/form {mode, region}` (`gamingApp/src/api/modules/matchmaking/business/services/matchFormationService.ts`). Order of writes and compensations:

1. **Redis reserve** (one Lua script, all-or-nothing): checks every ticket is still queued, snapshots the tickets into `mm:formation:{matchId}`, removes them from both ZSETs, deletes the tickets and sets `active_match`. First because it is the contention point and cheap to undo. Compensation: `restore`.
2. **Mongo create** `matches/{matchId}` (`$setOnInsert` upsert, so retries do not duplicate). Compensation: `deleteOne({_id: matchId})`.
3. **Redis commit** (Lua): refuses if a reserved player left, creates `match:{matchId}`, marks the formation `committed`. Idempotent.

Compensation (reverse order): delete the Mongo match, then Redis `restore`: recreates each ticket and its ZSET entries with the **original `mmr` and `enqueuedAt`** (seniority kept), clears `active_match` and marks `rolled_back`; running it again is a no-op. A reserved player who leaves is recorded as `abandoned:{playerId}` (see `abandonFormationScript`), so commit refuses and restore skips them. If the process dies mid-saga, `recover` compensates formations that stay `reserved`.

Fault injection: header `x-fail-at: matchmaking.reserve | matchmaking.createMatch | matchmaking.commit | matchmaking.restore`; header `x-pause-after-reserve-ms` stalls the saga after the reservation. Demo: `scripts/demo-problem-2.sh`.

Denormalization: the ticket keeps a snapshot of the player's `mmr` read from MongoDB (`players.ratings.<mode>.mmr`, falling back to `game_modes.initialRating`). It cannot go stale while the player is queued: ratings only change when a match closes (problem 4) or a sanction is reverted (problem 8), and a queued player is in neither.

Problem 1 joins a queue with one atomic Lua script (`gamingApp/src/api/modules/matchmaking/infrastructure/scripts/matchmakingScripts.ts`): it checks the ticket and `active_match` and writes the ticket and both ZSET entries in a single step, so concurrent requests for the same player cannot leave them in two queues. Tickets do not expire; stale tickets are handled by match formation (problem 2).

## Future additions

Add Redis configuration or repeatable seed scripts in this directory only when the application's access patterns require them. Keys used for caches, queues, locks, or temporary state should be documented with their naming convention and expiration policy.

Do not treat Redis seed data as durable source-of-truth data.
