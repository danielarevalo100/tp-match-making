import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Redis } from "ioredis";

import { RedisMatchClosureAdapter } from "../../src/api/modules/matchClosure/infrastructure/adapters/redisMatchClosureAdapter.js";
import { connectToRedis } from "../../src/infrastructure/redis/redisConnection.js";
import { redisKeys } from "../../src/shared/storageKeys.js";

const redisUrl = process.env["REDIS_URL"];

describe("RedisMatchClosureAdapter (real Redis)", { skip: redisUrl === undefined }, () => {
  let redis: Redis;
  let closure: RedisMatchClosureAdapter;
  const keys = new Set<string>();

  before(async () => {
    redis = await connectToRedis({ attempts: 3, delayMs: 500, url: redisUrl as string });
    closure = new RedisMatchClosureAdapter(redis);
  });

  after(async () => {
    if (keys.size > 0) await redis.del(...keys);
    await redis.quit();
  });

  const createMatch = async () => {
    const matchId = randomUUID();
    const players = [randomUUID(), randomUUID()];
    const matchKey = redisKeys.match(matchId);
    keys.add(matchKey);
    keys.add(redisKeys.matchScoreboard(matchId));
    keys.add(redisKeys.matchAppliedEvents(matchId));
    keys.add(redisKeys.matchClosure(matchId));
    await redis.hset(matchKey, {
      matchId,
      mode: "ranked_1v1",
      players: players.join(","),
      region: "TEST",
      startedAt: String(Date.now()),
      status: "in_progress",
    });
    for (const playerId of players) {
      const activeKey = redisKeys.activeMatch(playerId);
      keys.add(activeKey);
      await redis.set(activeKey, matchId);
    }
    return { matchId, players };
  };

  it("moves to closing and can compensate before the commit point", async () => {
    const { matchId } = await createMatch();
    const closureId = randomUUID();

    assert.equal(await closure.beginClosing(matchId, closureId), "closing");
    assert.equal(await closure.beginClosing(matchId, closureId), "replayed");
    await closure.rollbackClosing(matchId, closureId);
    assert.equal(await redis.hget(redisKeys.match(matchId), "status"), "in_progress");
  });

  it("releases every player atomically and a retry cannot touch a new match", async () => {
    const { matchId, players } = await createMatch();
    const closureId = randomUUID();
    await closure.beginClosing(matchId, closureId);

    assert.equal(await closure.release(matchId, closureId, players), "released");
    assert.equal(await redis.exists(redisKeys.match(matchId)), 0);
    for (const playerId of players)
      assert.equal(await redis.get(redisKeys.activeMatch(playerId)), null);

    const nextMatch = randomUUID();
    await redis.set(redisKeys.activeMatch(players[0] as string), nextMatch);
    assert.equal(await closure.release(matchId, closureId, players), "already_released");
    assert.equal(await redis.get(redisKeys.activeMatch(players[0] as string)), nextMatch);
  });
});
