import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Redis } from "ioredis";

import { RedisLeaderboardAdapter } from "../../src/api/modules/leaderboards/infrastructure/adapters/redisLeaderboardAdapter.js";
import { connectToRedis } from "../../src/infrastructure/redis/redisConnection.js";

const redisUrl = process.env["REDIS_URL"];

describe("RedisLeaderboardAdapter (real Redis)", { skip: redisUrl === undefined }, () => {
  let redis: Redis;
  let leaderboard: RedisLeaderboardAdapter;
  // A throwaway season per run keeps the keys apart from real boards.
  const seasonId = `test-${randomUUID().slice(0, 8)}`;
  const mode = "ranked_1v1";
  const ids = Array.from({ length: 30 }, () => randomUUID());

  before(async () => {
    redis = await connectToRedis({ attempts: 3, delayMs: 500, url: redisUrl as string });
    leaderboard = new RedisLeaderboardAdapter(redis);
    await leaderboard.publish(
      seasonId,
      mode,
      ids.map((playerId, index) => ({
        mmr: 2_000 - index * 10,
        playerId,
        region: index % 2 === 0 ? "NA" : "EU",
        revision: 1,
      })),
    );
  });

  after(async () => {
    const keys = await redis.keys(`lb:${seasonId}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("returns the top slice with 1-based positions and the board size", async () => {
    const top = await leaderboard.top({ mode, region: null, seasonId }, 10);

    assert.equal(top.totalPlayers, 30);
    assert.equal(top.entries.length, 10);
    assert.deepEqual(top.entries[0], { mmr: 2_000, playerId: ids[0], position: 1 });
    assert.equal(top.entries[9]?.playerId, ids[9]);
  });

  it("keeps a regional board per region", async () => {
    const top = await leaderboard.top({ mode, region: "EU", seasonId }, 100);

    assert.equal(top.totalPlayers, 15);
    assert.deepEqual(top.entries[0], { mmr: 1_990, playerId: ids[1], position: 1 });
  });

  it("returns the window around a player, trimmed at the top", async () => {
    const middle = await leaderboard.around({ mode, region: null, seasonId }, ids[15] as string, 5);
    assert.equal(middle?.position, 16);
    assert.deepEqual(
      middle?.entries.map((entry) => entry.position),
      [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    );

    const first = await leaderboard.around({ mode, region: null, seasonId }, ids[1] as string, 5);
    assert.equal(first?.position, 2);
    assert.equal(first?.entries[0]?.position, 1);
    assert.equal(first?.entries.length, 7);

    const missing = await leaderboard.around({ mode, region: null, seasonId }, randomUUID(), 5);
    assert.equal(missing, null);
  });

  it("ignores an older revision and moves a player whose region changed", async () => {
    const playerId = ids[0] as string;
    await leaderboard.publish(seasonId, mode, [{ mmr: 1, playerId, region: "NA", revision: 0 }]);
    let window = await leaderboard.around({ mode, region: null, seasonId }, playerId, 0);
    assert.equal(window?.entries[0]?.mmr, 2_000);

    await leaderboard.publish(seasonId, mode, [{ mmr: 2_100, playerId, region: "EU", revision: 2 }]);
    window = await leaderboard.around({ mode, region: "EU", seasonId }, playerId, 0);
    assert.deepEqual(window?.entries[0], { mmr: 2_100, playerId, position: 1 });
    assert.equal(await leaderboard.around({ mode, region: "NA", seasonId }, playerId, 0), null);
  });

  it("lists and removes members from every board", async () => {
    const playerId = ids[29] as string;
    assert.ok((await leaderboard.listMembers(seasonId, mode)).includes(playerId));

    assert.equal(await leaderboard.remove(seasonId, mode, [playerId]), 1);
    assert.equal(await leaderboard.around({ mode, region: null, seasonId }, playerId, 0), null);
    assert.equal(await leaderboard.around({ mode, region: "EU", seasonId }, playerId, 0), null);
    assert.equal((await leaderboard.listMembers(seasonId, mode)).includes(playerId), false);
  });
});
