import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import { EnqueuePlayer } from "../src/application/use-cases/enqueue-player.js";
import { GetQueueTicket } from "../src/application/use-cases/get-queue-ticket.js";
import { LeaveQueue } from "../src/application/use-cases/leave-queue.js";
import { QueueController } from "../src/presentation/http/controllers/queue-controller.js";
import {
  FixedClock,
  InMemoryEligibilityRepository,
  InMemoryMatchmakingQueue,
  SequentialIdGenerator,
} from "./support/in-memory.js";

const playerId = "6a634799-3b19-4f68-9bc2-9d9c2ecf1938";
const now = new Date("2026-10-14T12:00:00.000Z");

function buildTestApp() {
  const eligibility = new InMemoryEligibilityRepository();
  const queue = new InMemoryMatchmakingQueue();
  eligibility.players.set(playerId, {
    accountStatus: "active",
    id: playerId,
    ratings: { ranked_1v1: { mmr: 1_234 } },
    region: "LATAM",
  });

  const controller = new QueueController(
    new EnqueuePlayer(eligibility, queue, new FixedClock(now), new SequentialIdGenerator()),
    new GetQueueTicket(queue),
    new LeaveQueue(queue),
  );

  return {
    app: createApp({
      checkReadiness: async () => true,
      queueController: controller,
      serviceName: "matchmaking-service-test",
    }),
    eligibility,
    queue,
  };
}

describe("matchmaking queue API", () => {
  let context = buildTestApp();

  beforeEach(() => {
    context = buildTestApp();
  });

  const enqueue = (body: Record<string, unknown> = {}) =>
    request(context.app)
      .post("/matchmaking/queue")
      .send({ mode: "ranked_1v1", playerId, ...body });

  it("enqueues an active player with the rating of the requested mode", async () => {
    const response = await enqueue();

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      enqueuedAt: now.getTime(),
      mmr: 1_234,
      mode: "ranked_1v1",
      playerId,
      region: "LATAM",
      ticketId: "00000000-0000-4000-8000-000000000001",
    });
    assert.equal(context.queue.tickets.size, 1);
  });

  it("falls back to the mode initial rating when the player has none for it", async () => {
    context.eligibility.modes.set("casual_5v5", { id: "casual_5v5", initialRating: 900 });

    const response = await enqueue({ mode: "casual_5v5" });

    assert.equal(response.status, 201);
    assert.equal(response.body.mmr, 900);
  });

  it("uses the requested region when it is valid, normalized to upper case", async () => {
    const response = await enqueue({ region: "eu" });

    assert.equal(response.status, 201);
    assert.equal(response.body.region, "EU");
  });

  it("is idempotent for the same ticketId", async () => {
    const ticketId = "11111111-1111-4111-8111-111111111111";
    const first = await enqueue({ ticketId });
    const second = await enqueue({ ticketId });

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(context.queue.tickets.size, 1);
  });

  it("rejects a second queue with a different ticketId", async () => {
    await enqueue();
    const response = await enqueue({ region: "EU" });

    assert.equal(response.status, 409);
    assert.equal(response.body.error, "ALREADY_IN_QUEUE");
    assert.equal(response.body.ticket.region, "LATAM");
  });

  it("rejects a player with an active match", async () => {
    context.queue.activeMatches.set(playerId, "match-1");

    const response = await enqueue();

    assert.equal(response.status, 409);
    assert.equal(response.body.error, "ALREADY_IN_MATCH");
    assert.equal(response.body.matchId, "match-1");
    assert.equal(context.queue.tickets.size, 0);
  });

  it("rejects an unknown player", async () => {
    const response = await enqueue({ playerId: "22222222-2222-4222-8222-222222222222" });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "PLAYER_NOT_FOUND");
  });

  it("rejects accounts that are not active", async () => {
    context.eligibility.players.set(playerId, {
      accountStatus: "closed",
      id: playerId,
      ratings: {},
      region: "LATAM",
    });

    const response = await enqueue();

    assert.equal(response.status, 422);
    assert.equal(response.body.error, "ACCOUNT_NOT_ACTIVE");
  });

  it("rejects unknown modes and regions", async () => {
    const badMode = await enqueue({ mode: "nope" });
    const badRegion = await enqueue({ region: "MARS" });

    assert.equal(badMode.status, 422);
    assert.equal(badMode.body.error, "MODE_NOT_AVAILABLE");
    assert.equal(badRegion.status, 422);
    assert.equal(badRegion.body.error, "REGION_NOT_FOUND");
  });

  describe("sanctions", () => {
    const sanction = {
      id: "sanction-1",
      playerId,
      startsAt: new Date("2026-10-01T00:00:00.000Z"),
      status: "active" as const,
      type: "temporary_suspension",
    };

    it("rejects a player with a sanction in force", async () => {
      context.eligibility.sanctions.push({ ...sanction, endsAt: new Date("2026-10-20T00:00:00.000Z") });

      const response = await enqueue();

      assert.equal(response.status, 403);
      assert.equal(response.body.error, "PLAYER_SANCTIONED");
      assert.equal(response.body.sanctionId, "sanction-1");
      assert.equal(context.queue.tickets.size, 0);
    });

    it("rejects a permanent sanction (endsAt null)", async () => {
      context.eligibility.sanctions.push({ ...sanction, endsAt: null, type: "permanent_ban" });
      assert.equal((await enqueue()).status, 403);
    });

    it("ignores expired, revoked and not-yet-started sanctions", async () => {
      context.eligibility.sanctions.push(
        { ...sanction, endsAt: new Date("2026-10-10T00:00:00.000Z") },
        { ...sanction, endsAt: null, id: "s2", status: "revoked" },
        { ...sanction, endsAt: null, id: "s3", startsAt: new Date("2026-11-01T00:00:00.000Z") },
      );

      assert.equal((await enqueue()).status, 201);
    });
  });

  it("validates the request body", async () => {
    const response = await request(context.app)
      .post("/matchmaking/queue")
      .send({ mode: "ranked_1v1", playerId: "not-a-uuid", extra: true });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "VALIDATION_ERROR");
  });

  it("returns and removes the ticket of a queued player", async () => {
    await enqueue();

    const found = await request(context.app).get(`/matchmaking/queue/${playerId}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.mode, "ranked_1v1");

    const left = await request(context.app).delete(`/matchmaking/queue/${playerId}`);
    assert.equal(left.status, 204);

    const missing = await request(context.app).get(`/matchmaking/queue/${playerId}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "TICKET_NOT_FOUND");
  });
});
