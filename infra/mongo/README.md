# MongoDB infrastructure

MongoDB is the source of truth for durable domain data that is read in many different ways: players, static catalogs, administrators, reports and sanctions. Live state (matchmaking queues, matches in progress, leaderboards) lives in Redis, and match history and events live in Cassandra.

`init.js` creates every collection with a `$jsonSchema` validator and its indexes, and upserts the static catalogs. It is idempotent: it runs automatically on a fresh volume and can be reapplied with `scripts/initialize-infrastructure.*`. Reapplying updates validators (`collMod`) and catalog documents.

## Collections

| Collection       | `_id`               | Content                                                                             | Main indexes                                            |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `regions`        | Code (`LATAM`)      | Static catalog. Each region lists its ISO countries                                 | `countries` unique: a country belongs to one region     |
| `game_modes`     | Code (`ranked_5v5`) | Static catalog. Players per match, teams, ranked, matchmaking parameters            | `name` unique                                           |
| `seasons`        | Code (`2026-S2`)    | Static catalog with dates and status                                                | Partial unique on `status: "active"`: one active season |
| `players`        | UUID string         | Profile, normalized username/email, `country`, derived `region`, `ratings` per mode | `username`, `email` unique; `region`                    |
| `administrators` | UUID string         | Platform administrators                                                             | `username`, `email` unique                              |
| `reports`        | UUID string         | Reports; `reporterPlayerId: null` = automatic                                       | `reportedPlayerId + createdAt`; `status + createdAt`    |
| `sanctions`      | UUID string         | Sanctions; `endsAt: null` = permanent; `matchIds` and `reversal` journal (problem 8) | `playerId + status + endsAt`; `playerId + createdAt`    |

## Modeling decisions

- **Shared identifier:** `players._id` (and the other UUIDs) is the identifier used in every engine: Redis keys, Cassandra partitions and Neo4j nodes.
- **Rating per game mode** (DER recommendation): `players.ratings.<modeId> = { mmr, gamesPlayed, updatedAt }`. A map keyed by mode lets a single update target one mode (`$inc: { "ratings.ranked_5v5.mmr": 12 }`). Historical snapshots (`mmr_before` / `mmr_after`) stay with the match history.
- **Season standing** (problem 5): `players.seasonRatings.<seasonId>.<modeId> = { mmr, gamesPlayed, region, revision, updatedAt }`. Problem 4 writes it in the same update as `ratings` (aggregation pipeline), so the standing always copies the rating it belongs to. It is the durable source of the Redis leaderboards; positions are derived and live only in Redis. See `docs/problema5.md`.
- **Player region** (DER recommendation): derived from `country` through `regions.countries` when the player registers.
- **Normalized identity:** `username` and `email` are stored in lowercase. The API normalizes both and MongoDB validators reject uppercase values.
- **Profile audit:** `updatedAt` is initialized from `registeredAt` for existing records and changes whenever the profile or account status changes.
- **Sanctions vs. account status:** `accountStatus` only describes the account lifecycle (`active`, `inactive`, `closed`). Only the `sanctions` collection says whether a player is sanctioned. This avoids duplicating that fact and having to keep two copies in sync.
- **Sanction in force:** `status: "active"`, `startsAt <= now` and (`endsAt: null` or `endsAt > now`). Every sanction type blocks matchmaking.
- **Sanction with result reversal** (problem 8, schema v8): `sanctions.matchIds` lists the matches whose results are voided and `sanctions.reversal` is the journal of that reversal (`status`, `completedSteps`, `heldBoards`, `revertedMatchIds`, `attempts`, `lastError`). Sanction and journal are one document, so registering the sanction and starting the journal is a single atomic write. A voided match gets `status: "voided"` and `voided: { sanctionId, at }`; `players.revertedRatingMatches` is the idempotency guard of the reversal (the mirror of `appliedRatingMatches`), and a season standing can reach `gamesPlayed: 0`, which means it is no longer ranked. Reapply the schema on existing volumes. See `docs/problema8.md`.

Example check used by problem 1:

```js
db.sanctions.findOne({
  playerId,
  status: "active",
  startsAt: { $lte: now },
  $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
});
```

## Pending

- Player statistics (`ESTADISTICAS_JUGADOR`) are derived on read from the history in Cassandra (problem 6, see `docs/problema6.md`); they are not stored here.
- Bulk test data (≥ 50,000 records) belongs to the load script, not to this schema file. `pnpm seed` (in `gamingApp`) loads the data for the eight problems; `pnpm seed:reset` empties the engines first.
