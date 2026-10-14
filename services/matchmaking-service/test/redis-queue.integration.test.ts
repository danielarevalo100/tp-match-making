// Runs against a real Redis; skipped unless REDIS_URL is set, e.g.
//   REDIS_URL=redis://localhost:6379 npm test
// It uses throwaway player ids and cleans up the keys it creates.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Redis } from "ioredis";

import type { QueueTicket } from "../src/domain/entities/queue-ticket.js";
import {
  activeMatchKey,
  ratingQueueKey,
  ticketKey,
  waitQueueKey,
} from "../src/infrastructure/redis/keys.js";
import { connectToRedis } from "../src/infrastructure/redis/redis-connection.js";
import { RedisMatchmakingQueue } from "../src/infrastructure/redis/redis-matchmaking-queue.js";

const redisUrl = process.env["REDIS_URL"];

// A dedicated mode so the test never touches real queues.
const mode = `it_${randomUUID().slice(0, 8)}`;
const region = "TEST";

function ticketFor(playerId: string, overrides: Partial<QueueTicket> = {}): QueueTicket {
  return {
    enqueuedAt: Date.now(),
    mmr: 1_100,
    mode,
    playerId,
    region,
    ticketId: randomUUID(),
    ...overrides,
  };
}

describe("RedisMatchmakingQueue (real Redis)", { skip: redisUrl === undefined }, () => {
  let redis: Redis;
  let queue: RedisMatchmakingQueue;
  const playerIds: string[] = [];
  const newPlayer = (): string => {
    const id = randomUUID();
    playerIds.push(id);
    return id;
  };

  before(async () => {
    redis = await connectToRedis(redisUrl as string, { attempts: 3, delayMs: 500 });
    queue = new RedisMatchmakingQueue(redis);
  });

  after(async () => {
    const keys = playerIds.flatMap((id) => [ticketKey(id), activeMatchKey(id)]);
    if (keys.length > 0) await redis.del(...keys);
    await redis.del(ratingQueueKey(mode, region), waitQueueKey(mode, region));
    await redis.quit();
  });

  it("writes the ticket hash and both sorted sets", async () => {
    const playerId = newPlayer();
    const ticket = ticketFor(playerId, { enqueuedAt: 1_700_000_000_123, mmr: 1_337 });

    assert.equal((await queue.enqueue(ticket)).status, "enqueued");

    assert.deepEqual(await queue.findTicket(playerId), ticket);
    assert.equal(await redis.zscore(ratingQueueKey(mode, region), playerId), "1337");
    assert.equal(await redis.zscore(waitQueueKey(mode, region), playerId), "1700000000123");
  });

  it("replays the same ticketId and rejects a different one", async () => {
    const playerId = newPlayer();
    const first = ticketFor(playerId);
    await queue.enqueue(first);

    const replay = await queue.enqueue({ ...first, enqueuedAt: first.enqueuedAt + 5_000 });
    assert.equal(replay.status, "replayed");
    // The original ticket (and its antiquity) is kept, not the retried one.
    assert.deepEqual(replay.status === "replayed" && replay.ticket, first);

    const other = await queue.enqueue(ticketFor(playerId, { region: "OTHER" }));
    assert.equal(other.status, "already_in_queue");
    assert.equal(await redis.zscore(ratingQueueKey(mode, "OTHER"), playerId), null);
  });

  it("rejects a player with an active match and writes nothing", async () => {
    const playerId = newPlayer();
    await redis.set(activeMatchKey(playerId), "match-42");

    const outcome = await queue.enqueue(ticketFor(playerId));

    assert.deepEqual(outcome, { status: "already_in_match", matchId: "match-42" });
    assert.equal(await queue.findTicket(playerId), null);
    assert.equal(await redis.zscore(ratingQueueKey(mode, region), playerId), null);
  });

  it("lets only one of many concurrent requests for the same player win", async () => {
    const playerId = newPlayer();

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        queue.enqueue(ticketFor(playerId, { region: index % 2 === 0 ? region : "OTHER" })),
      ),
    );

    assert.equal(outcomes.filter((outcome) => outcome.status === "enqueued").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "already_in_queue").length, 49);

    const inRegion = await redis.zscore(ratingQueueKey(mode, region), playerId);
    const inOther = await redis.zscore(ratingQueueKey(mode, "OTHER"), playerId);
    assert.equal([inRegion, inOther].filter((score) => score !== null).length, 1);
    await redis.del(ratingQueueKey(mode, "OTHER"), waitQueueKey(mode, "OTHER"));
  });

  it("removes the ticket and both sorted set entries when leaving", async () => {
    const playerId = newPlayer();
    await queue.enqueue(ticketFor(playerId));

    assert.equal(await queue.leave(playerId), true);
    assert.equal(await queue.leave(playerId), false);
    assert.equal(await queue.findTicket(playerId), null);
    assert.equal(await redis.zscore(ratingQueueKey(mode, region), playerId), null);
    assert.equal(await redis.zscore(waitQueueKey(mode, region), playerId), null);
  });
});
