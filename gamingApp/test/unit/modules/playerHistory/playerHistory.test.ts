import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import request from "supertest";

import { createApp } from "../../../../src/api/app.js";
import type {
  ClosedMatch,
  HistoryRow,
  PlayerHistoryView,
  ProjectionResult,
} from "../../../../src/api/modules/playerHistory/business/models/playerHistory.js";
import { PlayerHistoryProjectionService } from "../../../../src/api/modules/playerHistory/business/services/playerHistoryProjectionService.js";
import { PlayerHistoryService } from "../../../../src/api/modules/playerHistory/business/services/playerHistoryService.js";
import { PlayerHistoryController } from "../../../../src/api/modules/playerHistory/presentation/controllers/playerHistoryController.js";
import { createPlayerHistoryRouter } from "../../../../src/api/modules/playerHistory/presentation/routers/playerHistoryRouter.js";
import { InjectedFailureError } from "../../../../src/shared/errors.js";
import { requestContext } from "../../../../src/shared/requestContext.js";
import {
  InMemoryClosedMatchSource,
  InMemoryPlayerDirectory,
  InMemoryPlayerHistoryStore,
} from "../../../support/inMemory/inMemoryPlayerHistory.js";

const now = new Date("2026-10-20T12:00:00.000Z");
const dayMs = 86_400_000;
const alice = randomUUID();
const bob = randomUUID();

function build() {
  const store = new InMemoryPlayerHistoryStore();
  const directory = new InMemoryPlayerDirectory();
  const source = new InMemoryClosedMatchSource();
  directory.players.set(alice, {
    id: alice,
    ratings: { ranked_1v1: { mmr: 1_100 } },
    username: "alice",
  });
  directory.season = {
    endsAt: new Date("2026-12-31T23:59:59.000Z"),
    id: "2026-S2",
    startsAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  const service = new PlayerHistoryService(directory, store);
  const projection = new PlayerHistoryProjectionService(source, store);
  const app = createApp({
    checkReadiness: async () => true,
    routes: [
      {
        path: "/history",
        router: createPlayerHistoryRouter(new PlayerHistoryController(service, projection)),
      },
    ],
    serviceName: "gaming-app-test",
  });
  return { app, directory, projection, service, source, store };
}

/** One match per day for 60 days: every third one (i % 3 === 0) is a loss. Rating: ±25. */
function seedAliceHistory(store: InMemoryPlayerHistoryStore): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let mmr = 1_000;
  for (let i = 59; i >= 0; i--) {
    const win = i % 3 !== 0;
    const delta = win ? 25 : -25;
    rows.push({
      deaths: win ? 5 : 6,
      endedAt: new Date(now.getTime() - i * dayMs - 3_600_000),
      kills: win ? 10 : 3,
      matchId: randomUUID(),
      mmrAfter: mmr + delta,
      mmrBefore: mmr,
      mode: "ranked_1v1",
      objectives: 1,
      playerId: alice,
      ratingDelta: delta,
      region: "LATAM",
      result: win ? "win" : "loss",
      score: 11,
    });
    mmr += delta;
  }
  for (const row of rows) {
    store.rows.set(`${row.playerId}|${String(row.endedAt.getTime())}|${row.matchId}`, row);
  }
  return rows;
}

describe("PlayerHistoryService", () => {
  let context = build();
  beforeEach(() => {
    context = build();
  });

  it("returns the last 50 matches, newest first", async () => {
    seedAliceHistory(context.store);

    const view = await context.service.getHistory(alice, now);

    assert.equal(view.matches.length, 50);
    const times = view.matches.map((match) => match.endedAt.getTime());
    assert.deepEqual(
      times,
      [...times].sort((a, b) => b - a),
    );
    assert.equal(view.player.username, "alice");
  });

  it("summarizes the week, the month and the season", async () => {
    seedAliceHistory(context.store);

    const { stats } = await context.service.getHistory(alice, now);

    // week: i = 0..6 -> losses at 0, 3, 6
    assert.equal(stats.week.matches, 7);
    assert.equal(stats.week.wins, 4);
    assert.equal(stats.week.losses, 3);
    assert.equal(stats.week.kills, 4 * 10 + 3 * 3);
    assert.equal(stats.week.deaths, 4 * 5 + 3 * 6);
    assert.equal(stats.week.killDeathRatio, 1.29);
    assert.equal(stats.week.winRate, 0.57);
    // month: i = 0..29 -> 10 losses
    assert.equal(stats.month.matches, 30);
    assert.equal(stats.month.wins, 20);
    // season started 2026-07-01, long before the oldest match
    assert.equal(stats.season?.seasonId, "2026-S2");
    assert.equal(stats.season?.matches, 60);
    assert.equal(stats.season?.wins, 40);
  });

  it("reports the rating evolution per mode, from the first match to the last of the period", async () => {
    const rows = seedAliceHistory(context.store);

    const { stats } = await context.service.getHistory(alice, now);

    const oldestInWeek = rows.find((row) => row.endedAt >= new Date(now.getTime() - 7 * dayMs));
    const newest = rows.at(-1);
    const evolution = stats.week.ratingEvolution[0];
    assert.equal(stats.week.ratingEvolution.length, 1);
    assert.equal(evolution?.mode, "ranked_1v1");
    assert.equal(evolution?.from, oldestInWeek?.mmrBefore);
    assert.equal(evolution?.to, newest?.mmrAfter);
    assert.equal(evolution?.change, (evolution?.to ?? 0) - (evolution?.from ?? 0));
    assert.equal(evolution?.points.length, 7);
  });

  it("has no ratio when there are no deaths and no season stats without an active season", async () => {
    context.directory.season = null;
    const endedAt = new Date(now.getTime() - 3_600_000);
    context.store.rows.set("k", {
      deaths: 0,
      endedAt,
      kills: 4,
      matchId: randomUUID(),
      mmrAfter: 1_025,
      mmrBefore: 1_000,
      mode: "ranked_1v1",
      objectives: 0,
      playerId: alice,
      ratingDelta: 25,
      region: "LATAM",
      result: "win",
      score: 4,
    });

    const { stats } = await context.service.getHistory(alice, now);

    assert.equal(stats.week.killDeathRatio, null);
    assert.equal(stats.season, null);
  });

  it("returns empty statistics for a player without matches", async () => {
    const { matches, stats } = await context.service.getHistory(alice, now);

    assert.equal(matches.length, 0);
    assert.equal(stats.week.matches, 0);
    assert.equal(stats.week.winRate, null);
    assert.deepEqual(stats.week.ratingEvolution, []);
  });

  it("rejects an unknown player and leaves a failed read without side effects", async () => {
    await assert.rejects(context.service.getHistory(randomUUID(), now), {
      name: "PlayerNotFoundError",
    });
    await assert.rejects(
      requestContext.run({ failAt: "playerHistory.findSince" }, () =>
        context.service.getHistory(alice, now),
      ),
      InjectedFailureError,
    );
    assert.equal(context.store.rows.size, 0);
  });
});

describe("PlayerHistoryProjectionService", () => {
  let context = build();
  beforeEach(() => {
    context = build();
  });

  const closedMatch = (id: string, endedAt: Date): ClosedMatch => ({
    endedAt,
    id,
    mode: "ranked_1v1",
    players: [
      {
        deaths: 2,
        kills: 5,
        mmrAfter: 1_025,
        mmrBefore: 1_000,
        objectives: 0,
        playerId: alice,
        ratingDelta: 25,
        result: "win",
        score: 5,
      },
      {
        deaths: 5,
        kills: 2,
        mmrAfter: 975,
        mmrBefore: 1_000,
        objectives: 0,
        playerId: bob,
        ratingDelta: -25,
        result: "loss",
        score: 2,
      },
    ],
    region: "LATAM",
  });

  it("writes one row per player and resumes from the cursor", async () => {
    context.source.matches.push(
      closedMatch("00000000-0000-4000-8000-000000000001", new Date(now.getTime() - 3 * dayMs)),
      closedMatch("00000000-0000-4000-8000-000000000002", new Date(now.getTime() - 2 * dayMs)),
      closedMatch("00000000-0000-4000-8000-000000000003", new Date(now.getTime() - dayMs)),
    );

    const first = await context.projection.project({ afterId: null, limit: 2 });
    assert.deepEqual(first, {
      matches: 2,
      nextCursor: "00000000-0000-4000-8000-000000000002",
      rows: 4,
    });

    const second = await context.projection.project({ afterId: first.nextCursor, limit: 2 });
    assert.deepEqual(second, { matches: 1, nextCursor: null, rows: 2 });
    assert.equal(context.store.rows.size, 6);

    const aliceRows = await context.store.findLatest(alice, 10);
    assert.equal(aliceRows[0]?.matchId, "00000000-0000-4000-8000-000000000003");
    assert.equal(aliceRows[0]?.mmrAfter, 1_025);
  });

  it("is idempotent: projecting everything again does not add rows", async () => {
    context.source.matches.push(
      closedMatch("00000000-0000-4000-8000-000000000001", new Date(now.getTime() - dayMs)),
    );

    await context.projection.project({ afterId: null, limit: 100 });
    await context.projection.project({ afterId: null, limit: 100 });

    assert.equal(context.store.rows.size, 2);
  });
});

describe("history API", () => {
  let context = build();
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now });
    context = build();
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("GET /history/players/:id returns matches and the three periods", async () => {
    seedAliceHistory(context.store);

    const response = await request(context.app).get(`/history/players/${alice}`);
    const body = response.body as PlayerHistoryView;

    assert.equal(response.status, 200);
    assert.equal(body.matches.length, 50);
    assert.equal(body.stats.week.matches, 7);
    assert.equal(body.stats.month.matches, 30);
    assert.equal(body.stats.season?.matches, 60);
  });

  it("answers 404 for an unknown player and 400 for a malformed id", async () => {
    const unknown = await request(context.app).get(`/history/players/${randomUUID()}`);
    const malformed = await request(context.app).get("/history/players/not-a-uuid");

    assert.equal(unknown.status, 404);
    assert.equal(malformed.status, 400);
  });

  it("POST /history/projection projects closed matches", async () => {
    context.source.matches.push({
      endedAt: new Date(now.getTime() - dayMs),
      id: "00000000-0000-4000-8000-000000000001",
      mode: "ranked_1v1",
      players: [
        {
          deaths: 0,
          kills: 1,
          mmrAfter: 1_025,
          mmrBefore: 1_000,
          objectives: 0,
          playerId: alice,
          ratingDelta: 25,
          result: "win",
          score: 1,
        },
        {
          deaths: 1,
          kills: 0,
          mmrAfter: 975,
          mmrBefore: 1_000,
          objectives: 0,
          playerId: bob,
          ratingDelta: -25,
          result: "loss",
          score: 0,
        },
      ],
      region: "LATAM",
    });

    const response = await request(context.app).post("/history/projection").send({});

    assert.equal(response.status, 200);
    assert.deepEqual(response.body as ProjectionResult, { matches: 1, nextCursor: null, rows: 2 });
  });

  it("maps an injected failure to a 500 with the step", async () => {
    const response = await request(context.app)
      .get(`/history/players/${alice}`)
      .set("x-fail-at", "playerHistory.findLatest");

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: "INJECTED_FAILURE",
      step: "playerHistory.findLatest",
    });
  });
});
