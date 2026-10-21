import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "../../../../src/api/app.js";
import type { PlayerProfile } from "../../../../src/api/modules/sanctions/business/models/playerProfile.js";
import type { SanctionView } from "../../../../src/api/modules/sanctions/business/models/sanction.js";
import { PlayerProfileController } from "../../../../src/api/modules/sanctions/presentation/controllers/playerProfileController.js";
import { SanctionController } from "../../../../src/api/modules/sanctions/presentation/controllers/sanctionController.js";
import { createPlayerProfileRouter } from "../../../../src/api/modules/sanctions/presentation/routers/playerProfileRouter.js";
import { createSanctionRouter } from "../../../../src/api/modules/sanctions/presentation/routers/sanctionRouter.js";
import { buildSanctionScenario, mode } from "../../../support/sanctionScenario.js";

type ErrorBody = { error: string; reason?: string; step?: string };

function build() {
  const scenario = buildSanctionScenario();
  const app = createApp({
    checkReadiness: async () => true,
    routes: [
      {
        path: "/sanctions",
        router: createSanctionRouter(new SanctionController(scenario.service)),
      },
      {
        path: "/profiles",
        router: createPlayerProfileRouter(new PlayerProfileController(scenario.profiles)),
      },
    ],
    serviceName: "gaming-app-test",
  });
  return { ...scenario, app };
}

describe("sanctions API", () => {
  let context = build();
  let sanctionId = randomUUID();
  let body: Record<string, unknown> = {};
  beforeEach(async () => {
    context = build();
    await context.publishAll();
    sanctionId = randomUUID();
    body = {
      administratorId: context.ids.administrator,
      endsAt: "2026-12-31T23:59:59Z",
      matchIds: [context.ids.m1, context.ids.m2],
      playerId: context.ids.cheater,
      reportId: context.ids.report,
      sanctionId,
      type: "temporary_suspension",
    };
  });

  it("POST /sanctions creates the sanction and completes the reversal (201); a retry gets 200", async () => {
    const created = await request(context.app).post("/sanctions").send(body);
    const sanction = created.body as SanctionView;

    assert.equal(created.status, 201);
    assert.equal(sanction.sanctionId, sanctionId);
    assert.equal(sanction.reason, "cheating");
    assert.equal(sanction.reversal.status, "completed");

    const replay = await request(context.app).post("/sanctions").send(body);
    assert.equal(replay.status, 200);
    assert.equal(context.results.rating(context.ids.cheater, mode)?.mmr, 1_475);
  });

  it("answers 202 when the reversal fails after the sanction is registered; resume completes it", async () => {
    const failed = await request(context.app)
      .post("/sanctions")
      .set("x-fail-at", "sanctions.revertRating")
      .send(body);
    const failedSanction = failed.body as SanctionView;

    assert.equal(failed.status, 202);
    assert.equal(failedSanction.status, "active");
    assert.equal(failedSanction.reversal.status, "failed");
    assert.match(failedSanction.reversal.lastError ?? "", /sanctions\.revertRating/);

    const resumed = await request(context.app).post(`/sanctions/${sanctionId}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal((resumed.body as SanctionView).reversal.status, "completed");

    const fetched = await request(context.app).get(`/sanctions/${sanctionId}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual((fetched.body as SanctionView).reversal.pendingMatchIds, []);
  });

  it("maps a failure before the sanction is written to a 500 with the step", async () => {
    const response = await request(context.app)
      .post("/sanctions")
      .set("x-fail-at", "sanctions.insertSanction")
      .send(body);

    assert.equal(response.status, 500);
    assert.deepEqual(response.body as ErrorBody, {
      error: "INJECTED_FAILURE",
      step: "sanctions.insertSanction",
    });
    assert.equal(context.repository.sanctions.size, 0);
  });

  it("validates the request", async () => {
    const repeated = await request(context.app)
      .post("/sanctions")
      .send({ ...body, matchIds: [context.ids.m1, context.ids.m1] });
    const malformed = await request(context.app)
      .post("/sanctions")
      .send({ ...body, playerId: "not-a-uuid" });
    const backwards = await request(context.app)
      .post("/sanctions")
      .send({ ...body, endsAt: "2026-01-01T00:00:00Z", startsAt: "2026-02-01T00:00:00Z" });

    assert.equal(repeated.status, 400);
    assert.equal(malformed.status, 400);
    assert.equal(backwards.status, 400);
    assert.equal(context.repository.sanctions.size, 0);
  });

  it("maps business errors to their status codes", async () => {
    const notPlayed = await request(context.app)
      .post("/sanctions")
      .send({ ...body, matchIds: [context.ids.m2], playerId: context.ids.rival1, reportId: null });
    assert.equal(notPlayed.status, 422);
    assert.deepEqual(
      [(notPlayed.body as ErrorBody).error, (notPlayed.body as ErrorBody).reason],
      ["MATCH_NOT_REVERSIBLE", "not_participant"],
    );

    await request(context.app).post("/sanctions").send(body);
    const conflict = await request(context.app)
      .post("/sanctions")
      .send({ ...body, matchIds: [context.ids.m1] });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as ErrorBody).error, "SANCTION_CONFLICT");

    const missing = await request(context.app).get(`/sanctions/${randomUUID()}`);
    assert.equal(missing.status, 404);
    assert.equal((missing.body as ErrorBody).error, "SANCTION_NOT_FOUND");
  });

  it("GET /profiles/:playerId returns the profile, and 404 for an unknown player", async () => {
    context.directory.players.set(context.ids.rival1, {
      player: {
        accountStatus: "active",
        country: "AR",
        id: context.ids.rival1,
        level: 3,
        region: "LATAM",
        registeredAt: new Date("2026-01-02T00:00:00Z"),
        username: "rival1",
      },
      ratings: [{ gamesPlayed: 2, mmr: 1_500, mode }],
      standings: [{ gamesPlayed: 2, mmr: 1_500, mode, region: "LATAM", seasonId: "2026-S2" }],
    });

    const response = await request(context.app).get(`/profiles/${context.ids.rival1}?matches=1`);
    const unknown = await request(context.app).get(`/profiles/${randomUUID()}`);
    const tooMany = await request(context.app).get(`/profiles/${context.ids.rival1}?matches=500`);
    const profile = response.body as PlayerProfile;

    assert.equal(response.status, 200);
    assert.equal(profile.player.username, "rival1");
    assert.equal(profile.recentMatches.length, 1);
    // bystander 1600, cheater 1525, rival1 1500, rival2 1475 (no sanction yet).
    assert.deepEqual(profile.leaderboards[0]?.global, { position: 3, totalPlayers: 4 });
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body as ErrorBody).error, "PLAYER_NOT_FOUND");
    assert.equal(tooMany.status, 400);
  });
});
