import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "../../../../src/api/app.js";
import type {
  EventPage,
  ReconcileResult,
  RecordResult,
  Scoreboard,
} from "../../../../src/api/modules/matchEvents/business/models/matchEvent.js";
import {
  MatchEventService,
  type RecordEventInput,
} from "../../../../src/api/modules/matchEvents/business/services/matchEventService.js";
import { MatchEventController } from "../../../../src/api/modules/matchEvents/presentation/controllers/matchEventController.js";
import { createMatchEventRouter } from "../../../../src/api/modules/matchEvents/presentation/routers/matchEventRouter.js";
import { InjectedFailureError } from "../../../../src/shared/errors.js";
import { requestContext } from "../../../../src/shared/requestContext.js";
import {
  InMemoryEventLog,
  InMemoryLiveScoreboard,
} from "../../../support/inMemory/inMemoryMatchEvents.js";

const matchId = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const outsider = randomUUID();

function build() {
  const log = new InMemoryEventLog();
  const scoreboard = new InMemoryLiveScoreboard();
  scoreboard.addLiveMatch(matchId, [alice, bob]);
  const service = new MatchEventService(log, scoreboard);
  const app = createApp({
    checkReadiness: async () => true,
    routes: [
      { path: "/matches", router: createMatchEventRouter(new MatchEventController(service)) },
    ],
    serviceName: "gaming-app-test",
  });
  return { app, log, scoreboard, service };
}

function kill(overrides: Partial<RecordEventInput> = {}): RecordEventInput {
  return {
    eventId: randomUUID(),
    matchId,
    playerId: alice,
    targetPlayerId: bob,
    tsMs: 1_700_000_000_000,
    type: "kill",
    ...overrides,
  };
}

function other(
  type: "objective" | "disconnect" | "reconnect",
  overrides: Partial<RecordEventInput> = {},
): RecordEventInput {
  return {
    eventId: randomUUID(),
    matchId,
    playerId: alice,
    tsMs: 1_700_000_000_000,
    type,
    ...overrides,
  };
}

const withFailure = <T>(step: string, run: () => Promise<T>): Promise<T> =>
  requestContext.run({ failAt: step }, run);

describe("MatchEventService", () => {
  let context = build();
  beforeEach(() => {
    context = build();
  });

  const score = async (): Promise<Scoreboard> => context.service.getScoreboard(matchId);
  const playerScore = async (playerId: string) =>
    (await score()).players.find((player) => player.playerId === playerId);

  it("logs the event and updates the scoreboard", async () => {
    const result = await context.service.record(kill());

    assert.equal(result.status, "recorded");
    assert.equal(context.log.rows.size, 1);
    assert.deepEqual(await playerScore(alice), {
      connected: true,
      deaths: 0,
      kills: 1,
      objectives: 0,
      playerId: alice,
      score: 1,
    });
    assert.equal((await playerScore(bob))?.deaths, 1);
    assert.equal((await score()).eventCount, 1);
  });

  it("scores objectives with their points and lists players without events", async () => {
    await context.service.record(other("objective", { points: 5 }));

    const board = await score();
    assert.equal(board.players[0]?.playerId, alice);
    assert.equal(board.players[0]?.score, 5);
    assert.equal(board.players[1]?.score, 0);
  });

  it("does not count a retried event twice, in either engine", async () => {
    const event = kill();
    await context.service.record(event);
    const retry = await context.service.record(event);

    assert.equal(retry.status, "duplicate");
    assert.equal(context.log.rows.size, 1);
    assert.equal((await playerScore(alice))?.kills, 1);
    assert.equal((await score()).eventCount, 1);
  });

  it("keeps events that happen in the same millisecond", async () => {
    await context.service.record(kill());
    await context.service.record(kill());

    assert.equal(context.log.rows.size, 2);
    assert.equal((await playerScore(alice))?.kills, 2);
  });

  it("rejects events for a match that is not live or players outside it", async () => {
    await assert.rejects(context.service.record(kill({ matchId: randomUUID() })), {
      name: "MatchNotLiveError",
    });
    await assert.rejects(context.service.record(kill({ playerId: outsider })), {
      name: "PlayerNotInMatchError",
    });
    assert.equal(context.log.rows.size, 0);
  });

  it("a failure writing the log leaves nothing behind in either engine", async () => {
    await assert.rejects(
      withFailure("matchEvents.appendEvent", () => context.service.record(kill())),
      InjectedFailureError,
    );

    assert.equal(context.log.rows.size, 0);
    assert.equal((await score()).eventCount, 0);
  });

  it("a failure updating the scoreboard leaves the event in the log; retrying heals it", async () => {
    const event = kill();
    await assert.rejects(
      withFailure("matchEvents.applyScoreboard", () => context.service.record(event)),
      InjectedFailureError,
    );

    assert.equal(context.log.rows.size, 1);
    assert.equal((await playerScore(alice))?.kills, 0);

    assert.equal((await context.service.record(event)).status, "recorded");
    assert.equal(context.log.rows.size, 1);
    assert.equal((await playerScore(alice))?.kills, 1);
  });

  it("reconcile applies the events the scoreboard is missing and nothing else", async () => {
    const first = kill({ tsMs: 1_700_000_000_001 });
    const second = kill({ tsMs: 1_700_000_000_002 });
    await context.service.record(first);
    await assert.rejects(
      withFailure("matchEvents.applyScoreboard", () => context.service.record(second)),
      InjectedFailureError,
    );

    assert.deepEqual(await context.service.reconcile(matchId), { read: 2, repaired: 1 });
    assert.equal((await playerScore(alice))?.kills, 2);
    assert.deepEqual(await context.service.reconcile(matchId), { read: 2, repaired: 0 });
  });

  it("reconcile rebuilds the whole scoreboard when the live state was lost", async () => {
    for (let index = 0; index < 1_200; index++) {
      await context.service.record(kill({ tsMs: 1_700_000_000_000 + index }));
    }
    context.scoreboard.boards.clear();
    context.scoreboard.applied.clear();

    assert.deepEqual(await context.service.reconcile(matchId), { read: 1_200, repaired: 1_200 });
    assert.equal((await playerScore(alice))?.kills, 1_200);
    assert.equal((await playerScore(bob))?.deaths, 1_200);
  });

  it("keeps the newest connection state whatever the arrival order", async () => {
    await context.service.record(other("reconnect", { tsMs: 2_000 }));
    await context.service.record(other("disconnect", { tsMs: 1_000 }));

    assert.equal((await playerScore(alice))?.connected, true);
  });

  it("lets a disconnect win a tie on the same millisecond", async () => {
    await context.service.record(other("disconnect", { tsMs: 1_000 }));
    await context.service.record(other("reconnect", { tsMs: 1_000 }));

    assert.equal((await playerScore(alice))?.connected, false);
  });

  it("pages through the log in time order", async () => {
    for (const tsMs of [30, 10, 20, 40, 50]) await context.service.record(kill({ tsMs }));

    const first = await context.service.listEvents(matchId, { limit: 2 });
    assert.deepEqual(
      first.events.map((event) => event.tsMs),
      [10, 20],
    );
    const second = await context.service.listEvents(matchId, {
      limit: 10,
      pageState: first.nextPageState ?? "",
    });
    assert.deepEqual(
      second.events.map((event) => event.tsMs),
      [30, 40, 50],
    );
    assert.equal(second.nextPageState, null);

    const range = await context.service.listEvents(matchId, {
      fromTsMs: 20,
      limit: 10,
      toTsMs: 40,
    });
    assert.equal(range.events.length, 3);
  });
});

describe("match events API", () => {
  let context = build();
  beforeEach(() => {
    context = build();
  });

  const post = (body: Record<string, unknown>, id = matchId) =>
    request(context.app).post(`/matches/${id}/events`).send(body);
  const valid = (overrides: Record<string, unknown> = {}) => ({
    eventId: randomUUID(),
    playerId: alice,
    targetPlayerId: bob,
    tsMs: 1_700_000_000_000,
    type: "kill",
    ...overrides,
  });

  it("answers 201 for a new event and 200 for a retry", async () => {
    const body = valid();
    const created = await post(body);
    const retried = await post(body);

    assert.equal(created.status, 201);
    assert.deepEqual(created.body as RecordResult, { eventId: body.eventId, status: "recorded" });
    assert.equal(retried.status, 200);
    assert.equal((retried.body as RecordResult).status, "duplicate");
  });

  it("serves the scoreboard and the event list", async () => {
    await post(valid());

    const board = await request(context.app).get(`/matches/${matchId}/scoreboard`);
    assert.equal(board.status, 200);
    assert.equal((board.body as Scoreboard).players[0]?.kills, 1);

    const events = await request(context.app).get(`/matches/${matchId}/events?limit=10`);
    assert.equal(events.status, 200);
    assert.equal((events.body as EventPage).events.length, 1);
  });

  it("reconciles on demand", async () => {
    await post(valid());
    const response = await request(context.app).post(`/matches/${matchId}/scoreboard/reconcile`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body as ReconcileResult, { read: 1, repaired: 0 });
  });

  it("validates the payload", async () => {
    assert.equal((await post(valid({ targetPlayerId: undefined }))).status, 400);
    assert.equal((await post(valid({ targetPlayerId: alice }))).status, 400);
    assert.equal((await post(valid({ type: "objective" }))).status, 400);
    assert.equal((await post(valid({ points: 3 }))).status, 400);
    assert.equal((await post(valid({ tsMs: undefined }))).status, 400);
    assert.equal((await post(valid({ eventId: "nope" }))).status, 400);
    assert.equal((await post(valid({ type: "heal" }))).status, 400);
    assert.equal((await request(context.app).get("/matches/nope/scoreboard")).status, 400);
    assert.equal(context.log.rows.size, 0);
  });

  it("answers 404 for a match that is not live and 422 for a stranger", async () => {
    const missing = await post(valid(), randomUUID());
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { error: string }).error, "MATCH_NOT_LIVE");

    const stranger = await post(valid({ playerId: outsider }));
    assert.equal(stranger.status, 422);
    assert.equal((stranger.body as { error: string }).error, "PLAYER_NOT_IN_MATCH");

    const board = await request(context.app).get(`/matches/${randomUUID()}/scoreboard`);
    assert.equal(board.status, 404);
  });

  it("injects a failure at the requested step", async () => {
    const response = await post(valid()).set("x-fail-at", "matchEvents.applyScoreboard");

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: "INJECTED_FAILURE",
      step: "matchEvents.applyScoreboard",
    });
    assert.equal(context.log.rows.size, 1);
  });
});
