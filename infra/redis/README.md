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
| `player:{playerId}:active_match` | STRING | `matchId` of the match the player is in. | created by problem 2, removed by problem 4 | none |

Denormalization: the ticket keeps a snapshot of the player's `mmr` read from MongoDB (`players.ratings.<mode>.mmr`, falling back to `game_modes.initialRating`). It cannot go stale while the player is queued: ratings only change when a match closes (problem 4) or a sanction is reverted (problem 8), and a queued player is in neither.

Problem 1 joins a queue with one atomic Lua script (`gamingApp/src/api/modules/matchmaking/infrastructure/scripts/matchmakingScripts.ts`): it checks the ticket and `active_match` and writes the ticket and both ZSET entries in a single step, so concurrent requests for the same player cannot leave them in two queues. Tickets do not expire; stale tickets are handled by match formation (problem 2).

## Future additions

Add Redis configuration or repeatable seed scripts in this directory only when the application's access patterns require them. Keys used for caches, queues, locks, or temporary state should be documented with their naming convention and expiration policy.

Do not treat Redis seed data as durable source-of-truth data.
