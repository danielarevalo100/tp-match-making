import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import request from "supertest";

import { createApp } from "../../../../src/api/app.js";
import type { QueueTicket } from "../../../../src/api/modules/matchmaking/business/models/queueTicket.js";
import { MatchmakingService } from "../../../../src/api/modules/matchmaking/business/services/matchmakingService.js";
import { MatchmakingController } from "../../../../src/api/modules/matchmaking/presentation/controllers/matchmakingController.js";
import { createMatchmakingRouter } from "../../../../src/api/modules/matchmaking/presentation/routers/matchmakingRouter.js";
import { InMemoryEligibilityRepository } from "../../../support/inMemory/inMemoryEligibilityRepository.js";
import { InMemoryMatchmakingQueue } from "../../../support/inMemory/inMemoryMatchmakingQueue.js";

type ErrorBody = {
  error: string;
  matchId?: string;
  sanctionId?: string;
  ticket?: QueueTicket;
};

const playerId = "6a634799-3b19-4f68-9bc2-9d9c2ecf1938";
const now = new Date("2026-10-14T12:00:00.000Z");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function buildTestApp() {
  const eligibility = new InMemoryEligibilityRepository();
  const queue = new InMemoryMatchmakingQueue();
  eligibility.players.set(playerId, {
    accountStatus: "active",
    id: playerId,
    ratings: { ranked_1v1: { mmr: 1_234 } },
    region: "LATAM",
  });

  const controller = new MatchmakingController(new MatchmakingService(eligibility, queue));

  return {
    app: createApp({
      checkReadiness: async () => true,
      routes: [{ path: "/matchmaking", router: createMatchmakingRouter(controller) }],
      serviceName: "gaming-app-test",
    }),
    eligibility,
    queue,
  };
}

describe("matchmaking queue API", () => {
  let context = buildTestApp();

  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now });
    context = buildTestApp();
  });

  afterEach(() => {
    mock.timers.reset();
  });

  const enqueue = (body: Record<string, unknown> = {}) =>
    request(context.app)
      .post("/matchmaking/queue")
      .send({ mode: "ranked_1v1", playerId, ...body });

  it("enqueues an active player with the rating of the requested mode", async () => {
    const response = await enqueue();
    const { ticketId, ...ticket } = response.body as QueueTicket;

    assert.equal(response.status, 201);
    assert.match(ticketId, uuidPattern);
    assert.deepEqual(ticket, {
      enqueuedAt: now.getTime(),
      mmr: 1_234,
      mode: "ranked_1v1",
      playerId,
      region: "LATAM",
    });
    assert.equal(context.queue.tickets.size, 1);
  });

  it("falls back to the mode initial rating when the player has none for it", async () => {
    context.eligibility.modes.set("casual_5v5", { id: "casual_5v5", initialRating: 900 });

    const response = await enqueue({ mode: "casual_5v5" });

    assert.equal(response.status, 201);
    assert.equal((response.body as QueueTicket).mmr, 900);
  });

  it("uses the requested region when it is valid, normalized to upper case", async () => {
    const response = await enqueue({ region: "eu" });

    assert.equal(response.status, 201);
    assert.equal((response.body as QueueTicket).region, "EU");
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
    const body = response.body as ErrorBody;

    assert.equal(response.status, 409);
    assert.equal(body.error, "ALREADY_IN_QUEUE");
    assert.equal(body.ticket?.region, "LATAM");
  });

  it("rejects a player with an active match", async () => {
    context.queue.activeMatches.set(playerId, "match-1");

    const response = await enqueue();
    const body = response.body as ErrorBody;

    assert.equal(response.status, 409);
    assert.equal(body.error, "ALREADY_IN_MATCH");
    assert.equal(body.matchId, "match-1");
    assert.equal(context.queue.tickets.size, 0);
  });

  it("rejects an unknown player", async () => {
    const response = await enqueue({ playerId: "22222222-2222-4222-8222-222222222222" });

    assert.equal(response.status, 404);
    assert.equal((response.body as ErrorBody).error, "PLAYER_NOT_FOUND");
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
    assert.equal((response.body as ErrorBody).error, "ACCOUNT_NOT_ACTIVE");
  });

  it("rejects unknown modes and regions", async () => {
    const badMode = await enqueue({ mode: "nope" });
    const badRegion = await enqueue({ region: "MARS" });

    assert.equal(badMode.status, 422);
    assert.equal((badMode.body as ErrorBody).error, "MODE_NOT_AVAILABLE");
    assert.equal(badRegion.status, 422);
    assert.equal((badRegion.body as ErrorBody).error, "REGION_NOT_FOUND");
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
      context.eligibility.sanctions.push({
        ...sanction,
        endsAt: new Date("2026-10-20T00:00:00.000Z"),
      });

      const response = await enqueue();
      const body = response.body as ErrorBody;

      assert.equal(response.status, 403);
      assert.equal(body.error, "PLAYER_SANCTIONED");
      assert.equal(body.sanctionId, "sanction-1");
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

  describe("sanction applied while queued", () => {
    const sanction = {
      endsAt: null,
      id: "sanction-1",
      playerId,
      startsAt: new Date("2026-10-01T00:00:00.000Z"),
      status: "active" as const,
      type: "permanent_ban",
    };
    const sanctionCheck = () =>
      request(context.app).post(`/matchmaking/queue/${playerId}/sanction-check`);

    it("evicts a queued player and reports the sanction", async () => {
      await enqueue();
      context.eligibility.sanctions.push(sanction);

      const response = await sanctionCheck();
      const body = response.body as { evicted: boolean; sanctioned: boolean };

      assert.equal(response.status, 200);
      assert.equal(body.evicted, true);
      assert.equal(body.sanctioned, true);
      assert.equal(context.queue.tickets.size, 0);
    });

    it("keeps a queued player without sanction", async () => {
      await enqueue();

      const response = await sanctionCheck();

      assert.deepEqual(response.body, { evicted: false, sanctioned: false });
      assert.equal(context.queue.tickets.size, 1);
    });

    it("removes the ticket if a sanction lands during enqueue", async () => {
      const original = context.eligibility.findSanctionInForce.bind(context.eligibility);
      let calls = 0;
      context.eligibility.findSanctionInForce = async (id, at) => {
        calls++;
        if (calls === 2) context.eligibility.sanctions.push(sanction);
        return original(id, at);
      };

      const response = await enqueue();

      assert.equal(response.status, 403);
      assert.equal(context.queue.tickets.size, 0);
    });
  });

  it("validates the request body", async () => {
    const response = await request(context.app)
      .post("/matchmaking/queue")
      .send({ mode: "ranked_1v1", playerId: "not-a-uuid", extra: true });

    assert.equal(response.status, 400);
    assert.equal((response.body as ErrorBody).error, "VALIDATION_ERROR");
  });

  it("returns and removes the ticket of a queued player", async () => {
    await enqueue();

    const found = await request(context.app).get(`/matchmaking/queue/${playerId}`);
    assert.equal(found.status, 200);
    assert.equal((found.body as QueueTicket).mode, "ranked_1v1");

    const left = await request(context.app).delete(`/matchmaking/queue/${playerId}`);
    assert.equal(left.status, 204);

    const missing = await request(context.app).get(`/matchmaking/queue/${playerId}`);
    assert.equal(missing.status, 404);
    assert.equal((missing.body as ErrorBody).error, "TICKET_NOT_FOUND");
  });
});
