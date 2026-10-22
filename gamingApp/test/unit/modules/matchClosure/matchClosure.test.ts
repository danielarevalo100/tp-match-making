import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "../../../../src/api/app.js";
import type {
  FinishMatchInput,
  MatchClosureRecord,
} from "../../../../src/api/modules/matchClosure/business/models/matchClosure.js";
import { MatchClosureService } from "../../../../src/api/modules/matchClosure/business/services/matchClosureService.js";
import { MatchClosureController } from "../../../../src/api/modules/matchClosure/presentation/controllers/matchClosureController.js";
import { createMatchClosureRouter } from "../../../../src/api/modules/matchClosure/presentation/routers/matchClosureRouter.js";
import { InjectedFailureError, type StorageEngine } from "../../../../src/shared/errors.js";
import { requestContext } from "../../../../src/shared/requestContext.js";
import { failOnce } from "../../../support/failOnce.js";
import { InMemoryLeaderboardRanking } from "../../../support/inMemory/inMemoryLeaderboards.js";
import {
  InMemoryLiveMatchClosure,
  InMemoryMatchClosureLog,
  InMemoryMatchClosureRepository,
} from "../../../support/inMemory/inMemoryMatchClosure.js";

const matchId = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const season = "2026-S2";
const mode = "ranked_1v1";

function build() {
  const matches = new InMemoryMatchClosureRepository();
  const live = new InMemoryLiveMatchClosure();
  const log = new InMemoryMatchClosureLog();
  const leaderboard = new InMemoryLeaderboardRanking();
  const match: MatchClosureRecord = {
    closureId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    eventId: null,
    id: matchId,
    leaderboardStatus: "pending",
    mode,
    players: [
      { enqueuedAt: 1, mmr: 1_500, playerId: alice },
      { enqueuedAt: 2, mmr: 1_520, playerId: bob },
    ],
    results: null,
    scoringStatus: "not_started",
    status: "in_progress",
  };
  matches.matches.set(matchId, match);
  matches.ratings.set(alice, 1_500);
  matches.ratings.set(bob, 1_520);
  matches.regions.set(alice, "LATAM");
  live.live.set(matchId, { closureId: null, players: [alice, bob], status: "in_progress" });
  live.activeMatches.set(alice, matchId);
  live.activeMatches.set(bob, matchId);
  log.events.push(
    { playerId: alice, points: 1, targetPlayerId: bob, type: "kill" },
    { playerId: alice, points: 10, targetPlayerId: null, type: "objective" },
  );
  const service = new MatchClosureService(matches, live, log, leaderboard);
  const app = createApp({
    checkReadiness: async () => true,
    routes: [
      {
        path: "/matches",
        router: createMatchClosureRouter(new MatchClosureController(service)),
      },
    ],
    serviceName: "gaming-app-test",
  });
  return { app, leaderboard, live, log, matches, service };
}

function finish(overrides: Partial<FinishMatchInput> = {}): FinishMatchInput {
  return {
    closureId: randomUUID(),
    eventId: randomUUID(),
    matchId,
    reason: "normal",
    results: [
      { playerId: alice, result: "win" },
      { playerId: bob, result: "loss" },
    ],
    tsMs: 1_700_000_100_000,
    ...overrides,
  };
}

const withFailedDb = <T>(engine: StorageEngine, run: () => Promise<T>): Promise<T> =>
  requestContext.run({ failDb: engine }, run);

describe("MatchClosureService", () => {
  let context = build();
  beforeEach(() => {
    context = build();
  });

  it("closes the match, releases players and applies the eventual score", async () => {
    const input = finish();
    const result = await context.service.finish(input);

    assert.deepEqual(result, {
      closureId: input.closureId,
      leaderboardStatus: "published",
      matchId,
      playersReleased: true,
      scoringStatus: "applied",
      status: "closed",
    });
    assert.equal(context.log.finished.size, 1);
    assert.equal(context.live.live.has(matchId), false);
    assert.equal(context.live.activeMatches.size, 0);
    assert.equal(context.matches.matches.get(matchId)?.status, "closed");
    assert.equal(context.matches.ratings.get(alice), 1_525);
    assert.equal(context.matches.ratings.get(bob), 1_495);
    assert.deepEqual(context.matches.finalScores.get(matchId)?.[0], {
      deaths: 0,
      kills: 1,
      mmrAfter: 1_525,
      mmrBefore: 1_500,
      objectives: 1,
      playerId: alice,
      ratingDelta: 25,
      result: "win",
      score: 11,
    });
  });

  it("compensates preparation when the injected Cassandra failure happened before commit", async () => {
    const input = finish();
    await assert.rejects(
      withFailedDb("cassandra", () => context.service.finish(input)),
      InjectedFailureError,
    );

    assert.equal(context.matches.matches.get(matchId)?.status, "in_progress");
    assert.equal(context.live.live.get(matchId)?.status, "in_progress");
    assert.equal(context.live.activeMatches.size, 2);
    assert.equal(context.log.finished.size, 0);
  });

  it("does not roll back after the finish event and resumes forward on retry", async () => {
    const input = finish();
    failOnce(context.live, "release", "redis");
    await assert.rejects(context.service.finish(input), InjectedFailureError);

    assert.equal(context.log.finished.size, 1);
    assert.equal(context.matches.matches.get(matchId)?.status, "closing");
    assert.equal(context.live.live.get(matchId)?.status, "closing");

    const retried = await context.service.finish(input);
    assert.equal(retried.status, "closed");
    assert.equal(context.live.activeMatches.size, 0);
  });

  it("keeps the match closed and players free when scoring fails", async () => {
    const input = finish();
    failOnce(context.log, "listScoringEvents", "cassandra");
    const result = await context.service.finish(input);

    assert.equal(result.scoringStatus, "failed");
    assert.equal(context.matches.matches.get(matchId)?.status, "closed");
    assert.equal(context.matches.matches.get(matchId)?.scoringStatus, "failed");
    assert.equal(context.live.activeMatches.size, 0);
  });

  it("retries failed scoring without applying ratings twice", async () => {
    const input = finish();
    failOnce(context.matches, "completeScoring", "mongo");
    await context.service.finish(input);
    assert.equal(context.matches.ratings.get(alice), 1_525);

    const retried = await context.service.finish(input);
    assert.equal(retried.scoringStatus, "applied");
    assert.equal(context.matches.ratings.get(alice), 1_525);
    assert.equal(context.matches.ratingApplications.size, 2);
  });

  it("does not downgrade applied scoring when the completion response is lost", async () => {
    const input = finish();
    failOnce(context.matches, "completeScoring", "mongo", { afterRunning: true });
    const result = await context.service.finish(input);

    assert.equal(result.scoringStatus, "applied");
    assert.equal(context.matches.matches.get(matchId)?.scoringStatus, "applied");
    assert.equal(context.matches.ratings.get(alice), 1_525);
  });

  it("publishes the season standings once ratings and the final scoreboard are durable", async () => {
    await context.service.finish(finish());

    assert.deepEqual(context.leaderboard.standing(season, mode, alice), {
      mmr: 1_525,
      region: "LATAM",
      revision: 1,
    });
    assert.deepEqual(context.leaderboard.standing(season, mode, bob), {
      mmr: 1_495,
      region: "NA",
      revision: 1,
    });
    assert.equal(context.matches.matches.get(matchId)?.leaderboardStatus, "published");
  });

  it("never publishes the leaderboard ahead of the rating or the final scoreboard", async () => {
    const input = finish();
    failOnce(context.matches, "completeScoring", "mongo");
    const result = await context.service.finish(input);

    assert.equal(result.scoringStatus, "failed");
    assert.equal(result.leaderboardStatus, "pending");
    assert.equal(context.matches.finalScores.has(matchId), false);
    assert.equal(context.leaderboard.publications, 0);
    assert.equal(context.leaderboard.standing(season, mode, alice), undefined);
  });

  it("keeps scoring applied and retries only the leaderboard when publishing fails", async () => {
    const input = finish();
    failOnce(context.leaderboard, "publish", "redis");
    const result = await context.service.finish(input);

    assert.equal(result.scoringStatus, "applied");
    assert.equal(result.leaderboardStatus, "pending");
    assert.equal(context.matches.ratings.get(alice), 1_525);
    assert.equal(context.leaderboard.standing(season, mode, alice), undefined);

    const retried = await context.service.finish(input);
    assert.equal(retried.leaderboardStatus, "published");
    assert.equal(context.matches.ratings.get(alice), 1_525);
    assert.equal(context.leaderboard.standing(season, mode, alice)?.mmr, 1_525);

    const replayed = await context.service.finish(input);
    assert.equal(replayed.leaderboardStatus, "published");
    assert.equal(context.leaderboard.publications, 1);
  });

  it("does not let a late retry regress a newer standing", async () => {
    context.leaderboard.boards.set(
      `${season}|${mode}`,
      new Map([[alice, { mmr: 1_550, region: "LATAM", revision: 2 }]]),
    );
    await context.service.finish(finish());

    assert.deepEqual(context.leaderboard.standing(season, mode, alice), {
      mmr: 1_550,
      region: "LATAM",
      revision: 2,
    });
  });

  it("skips the leaderboard when the match does not count for a ranked season", async () => {
    context.matches.leaderboardSeason = null;
    const result = await context.service.finish(finish());

    assert.equal(result.leaderboardStatus, "not_ranked");
    assert.equal(context.matches.ratings.get(alice), 1_525);
    assert.equal(context.leaderboard.publications, 0);
  });

  it("rejects incomplete or foreign results before changing state", async () => {
    await assert.rejects(
      context.service.finish(finish({ results: [{ playerId: alice, result: "win" }] })),
      {
        name: "MatchClosureParticipantsError",
      },
    );
    await assert.rejects(
      context.service.finish(
        finish({
          results: [
            { playerId: alice, result: "win" },
            { playerId: randomUUID(), result: "loss" },
          ],
        }),
      ),
      { name: "MatchClosureParticipantsError" },
    );
    assert.equal(context.matches.matches.get(matchId)?.status, "in_progress");
  });
});

describe("match closure API", () => {
  it("answers 202 while the leaderboard is still pending", async () => {
    const context = build();
    const input = finish();
    const { matchId: _matchId, ...body } = input;
    failOnce(context.leaderboard, "publish", "redis");
    const response = await request(context.app).post(`/matches/${matchId}/finish`).send(body);

    assert.equal(response.status, 202);
    assert.equal((response.body as { leaderboardStatus: string }).leaderboardStatus, "pending");
  });

  it("answers 500 and leaves the match open when Cassandra fails (x-fail-db)", async () => {
    const context = build();
    const { matchId: _matchId, ...body } = finish();
    const response = await request(context.app)
      .post(`/matches/${matchId}/finish`)
      .set("x-fail-db", "cassandra")
      .send(body);

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: "INJECTED_FAILURE", engine: "cassandra" });
    assert.equal(context.matches.matches.get(matchId)?.status, "in_progress");
    assert.equal(context.live.live.get(matchId)?.status, "in_progress");
  });

  it("validates and closes a match", async () => {
    const context = build();
    const input = finish();
    const { matchId: _matchId, ...body } = input;
    const response = await request(context.app).post(`/matches/${matchId}/finish`).send(body);

    assert.equal(response.status, 200);
    assert.equal((response.body as { status: string }).status, "closed");
  });

  it("returns 400 when the request does not contain enough results", async () => {
    const context = build();
    const input = finish({ results: [{ playerId: alice, result: "win" }] });
    const { matchId: _matchId, ...body } = input;
    const response = await request(context.app).post(`/matches/${matchId}/finish`).send(body);

    assert.equal(response.status, 400);
  });
});
