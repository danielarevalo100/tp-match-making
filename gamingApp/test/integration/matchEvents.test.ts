import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Client } from "cassandra-driver";
import type { Redis } from "ioredis";

import { MatchEventService } from "../../src/api/modules/matchEvents/business/services/matchEventService.js";
import { CassandraEventLogAdapter } from "../../src/api/modules/matchEvents/infrastructure/adapters/cassandraEventLogAdapter.js";
import { RedisScoreboardAdapter } from "../../src/api/modules/matchEvents/infrastructure/adapters/redisScoreboardAdapter.js";
import { connectToCassandra } from "../../src/infrastructure/cassandra/cassandraConnection.js";
import { connectToRedis } from "../../src/infrastructure/redis/redisConnection.js";
import { redisKeys } from "../../src/shared/storageKeys.js";

const redisUrl = process.env["REDIS_URL"];
const cassandraHost = process.env["CASSANDRA_CONTACT_POINTS"];

describe(
  "match events (real Redis and Cassandra)",
  { skip: redisUrl === undefined || cassandraHost === undefined },
  () => {
    let redis: Redis;
    let cassandra: Client;
    let service: MatchEventService;
    const matchIds: string[] = [];

    const newMatch = async (players: string[]): Promise<string> => {
      const matchId = randomUUID();
      matchIds.push(matchId);
      // What problem 2 publishes when a match is committed.
      await redis.hset(redisKeys.match(matchId), {
        matchId,
        mode: "ranked_1v1",
        players: players.join(","),
        region: "TEST",
        startedAt: String(Date.now()),
        status: "in_progress",
      });
      return matchId;
    };

    before(async () => {
      redis = await connectToRedis({ attempts: 3, delayMs: 500, url: redisUrl as string });
      cassandra = await connectToCassandra({
        attempts: 3,
        contactPoints: (cassandraHost as string).split(","),
        delayMs: 1_000,
        keyspace: process.env["CASSANDRA_KEYSPACE"] ?? "gaming",
        localDataCenter: process.env["CASSANDRA_LOCAL_DATACENTER"] ?? "datacenter1",
        port: Number(process.env["CASSANDRA_PORT"] ?? 9_042),
      });
      service = new MatchEventService(
        new CassandraEventLogAdapter(cassandra),
        new RedisScoreboardAdapter(redis),
      );
    });

    after(async () => {
      for (const matchId of matchIds) {
        await redis.del(
          redisKeys.match(matchId),
          redisKeys.matchScoreboard(matchId),
          redisKeys.matchAppliedEvents(matchId),
        );
        await cassandra.execute("DELETE FROM events_by_match WHERE match_id = ?", [matchId]);
      }
      await redis.quit();
      await cassandra.shutdown();
    });

    it("counts exactly once under concurrency and retries, and keeps every event", async () => {
      const [alice, bob] = [randomUUID(), randomUUID()];
      const matchId = await newMatch([alice, bob]);
      const tsMs = Date.now();
      const events = Array.from({ length: 200 }, (_unused, index) => ({
        eventId: randomUUID(),
        matchId,
        playerId: index % 2 === 0 ? alice : bob,
        targetPlayerId: index % 2 === 0 ? bob : alice,
        // Many events share the same millisecond on purpose.
        tsMs: tsMs + Math.floor(index / 10),
        type: "kill" as const,
      }));

      // Every event is sent three times at once, as a client retrying aggressively would.
      const results = await Promise.all(
        events.flatMap((event) => [1, 2, 3].map(() => service.record(event))),
      );

      assert.equal(results.filter((result) => result.status === "recorded").length, 200);
      assert.equal(results.filter((result) => result.status === "duplicate").length, 400);

      const board = await service.getScoreboard(matchId);
      assert.equal(board.eventCount, 200);
      for (const player of board.players) {
        assert.equal(player.kills, 100);
        assert.equal(player.deaths, 100);
        assert.equal(player.score, 100);
      }

      const stored: number[] = [];
      let pageState: string | undefined;
      do {
        const page = await service.listEvents(matchId, {
          limit: 70,
          ...(pageState ? { pageState } : {}),
        });
        stored.push(...page.events.map((event) => event.tsMs));
        pageState = page.nextPageState ?? undefined;
      } while (pageState);
      assert.equal(stored.length, 200);
      assert.deepEqual(
        stored,
        [...stored].sort((a, b) => a - b),
      );
    });

    it("rebuilds the scoreboard from the log after the live state is lost", async () => {
      const [alice, bob] = [randomUUID(), randomUUID()];
      const matchId = await newMatch([alice, bob]);
      for (let index = 0; index < 30; index++) {
        await service.record({
          eventId: randomUUID(),
          matchId,
          playerId: alice,
          targetPlayerId: bob,
          tsMs: Date.now() + index,
          type: "kill",
        });
      }
      await redis.del(redisKeys.matchScoreboard(matchId), redisKeys.matchAppliedEvents(matchId));
      assert.equal((await service.getScoreboard(matchId)).eventCount, 0);

      assert.deepEqual(await service.reconcile(matchId), { read: 30, repaired: 30 });
      assert.equal((await service.getScoreboard(matchId)).players[0]?.kills, 30);
    });

    it("does not score events for a match that has closed", async () => {
      const [alice, bob] = [randomUUID(), randomUUID()];
      const matchId = await newMatch([alice, bob]);
      await redis.del(redisKeys.match(matchId));

      await assert.rejects(
        service.record({
          eventId: randomUUID(),
          matchId,
          playerId: alice,
          targetPlayerId: bob,
          tsMs: Date.now(),
          type: "kill",
        }),
        { name: "MatchNotLiveError" },
      );
      assert.equal(await redis.exists(redisKeys.matchScoreboard(matchId)), 0);
    });
  },
);
