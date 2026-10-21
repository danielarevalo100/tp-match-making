import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import request from "supertest";

import { createApp } from "../../../../src/api/app.js";
import type {
  IrregularBehaviorResult,
  MatchFixingResult,
  OpposingPair,
  ReportedPlayerReports,
} from "../../../../src/api/modules/fraudDetection/business/models/fraud.js";
import {
  buildMatchFixingGroups,
  findReportBursts,
} from "../../../../src/api/modules/fraudDetection/business/services/detectionRules.js";
import { FraudDetectionService } from "../../../../src/api/modules/fraudDetection/business/services/fraudDetectionService.js";
import { FraudGraphProjectionService } from "../../../../src/api/modules/fraudDetection/business/services/fraudGraphProjectionService.js";
import { FraudController } from "../../../../src/api/modules/fraudDetection/presentation/controllers/fraudController.js";
import { createFraudRouter } from "../../../../src/api/modules/fraudDetection/presentation/routers/fraudRouter.js";
import type { ClosedMatch } from "../../../../src/api/modules/playerHistory/business/models/playerHistory.js";
import { InjectedFailureError } from "../../../../src/shared/errors.js";
import { requestContext } from "../../../../src/shared/requestContext.js";
import {
  InMemoryMatchGraph,
  InMemoryPlayerNames,
  InMemoryReports,
} from "../../../support/inMemory/inMemoryFraud.js";
import { InMemoryClosedMatchSource } from "../../../support/inMemory/inMemoryPlayerHistory.js";

const now = new Date("2026-10-20T12:00:00.000Z");
const dayMs = 86_400_000;
const minuteMs = 60_000;

describe("buildMatchFixingGroups", () => {
  const rules = { minBenefitRatio: 1, minMatches: 5 };
  const pair = (playerA: string, playerB: string, winsA: number, winsB: number): OpposingPair => ({
    matches: winsA + winsB,
    playerA,
    playerB,
    winsA,
    winsB,
  });

  it("groups the opponents that one player always beats", () => {
    const groups = buildMatchFixingGroups(
      [pair("a", "b", 8, 0), pair("a", "c", 6, 0), pair("d", "k", 0, 7)],
      rules,
    );

    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.beneficiary.playerId, "a");
    assert.deepEqual(
      groups[0]?.partners.map((partner) => partner.playerId),
      ["b", "c"],
    );
    assert.equal(groups[0]?.totalMatches, 14);
    // the beneficiary can be the second player of the pair
    assert.equal(groups[1]?.beneficiary.playerId, "k");
    assert.equal(groups[1]?.partners[0]?.playerId, "d");
  });

  it("ignores pairs with too few matches, no clear winner or a share below the ratio", () => {
    const pairs = [pair("a", "b", 3, 0), pair("c", "d", 3, 3), pair("e", "f", 6, 2)];

    assert.deepEqual(buildMatchFixingGroups(pairs, rules), []);
    const relaxed = buildMatchFixingGroups(pairs, { minBenefitRatio: 0.75, minMatches: 5 });
    assert.equal(relaxed.length, 1);
    assert.equal(relaxed[0]?.beneficiary.playerId, "e");
    assert.equal(relaxed[0]?.partners[0]?.benefitRatio, 0.75);
  });
});

describe("findReportBursts", () => {
  const rules = { minReporters: 3, windowMs: 60 * minuteMs };
  const reports = (
    reportedPlayerId: string,
    entries: [reporter: string, atMs: number][],
  ): ReportedPlayerReports => ({
    reportedPlayerId,
    reports: entries.map(([reporterPlayerId, atMs]) => ({
      createdAt: new Date(now.getTime() - atMs),
      reportId: randomUUID(),
      reporterPlayerId,
    })),
  });

  it("flags a player reported by several different people inside the window", () => {
    const alerts = findReportBursts(
      [
        reports("x", [
          ["r1", 20 * minuteMs],
          ["r2", 15 * minuteMs],
          ["r3", 10 * minuteMs],
          ["r4", 5 * minuteMs],
        ]),
      ],
      rules,
    );

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.distinctReporters, 4);
    assert.equal(alerts[0]?.reportIds.length, 4);
  });

  it("does not flag reports spread over time or repeated by one reporter", () => {
    const alerts = findReportBursts(
      [
        reports("spread", [
          ["r1", 4 * dayMs],
          ["r2", 3 * dayMs],
          ["r3", 2 * dayMs],
        ]),
        reports("repeated", [
          ["r1", 10 * minuteMs],
          ["r1", 8 * minuteMs],
          ["r1", 6 * minuteMs],
          ["r1", 4 * minuteMs],
        ]),
      ],
      rules,
    );

    assert.deepEqual(alerts, []);
  });

  it("picks the busiest window when there are an old and a recent burst", () => {
    const alerts = findReportBursts(
      [
        reports("x", [
          ["r1", 5 * dayMs],
          ["r2", 5 * dayMs - minuteMs],
          ["r3", 30 * minuteMs],
          ["r4", 20 * minuteMs],
          ["r5", 10 * minuteMs],
        ]),
      ],
      rules,
    );

    assert.equal(alerts[0]?.distinctReporters, 3);
    assert.deepEqual(alerts[0]?.reporters, ["r3", "r4", "r5"]);
  });
});

function duel(
  id: string,
  winner: string,
  loser: string,
  daysAgo: number,
  mode = "ranked_1v1",
): ClosedMatch {
  const base = { deaths: 0, kills: 0, objectives: 0, score: 0 };
  return {
    endedAt: new Date(now.getTime() - daysAgo * dayMs),
    id,
    mode,
    players: [
      {
        ...base,
        mmrAfter: 1_025,
        mmrBefore: 1_000,
        playerId: winner,
        ratingDelta: 25,
        result: "win",
      },
      {
        ...base,
        mmrAfter: 975,
        mmrBefore: 1_000,
        playerId: loser,
        ratingDelta: -25,
        result: "loss",
      },
    ],
    region: "LATAM",
  };
}

function build() {
  const graph = new InMemoryMatchGraph();
  const reports = new InMemoryReports();
  const names = new InMemoryPlayerNames();
  const source = new InMemoryClosedMatchSource();
  const detection = new FraudDetectionService(graph, reports, names);
  const projection = new FraudGraphProjectionService(source, graph);
  const app = createApp({
    checkReadiness: async () => true,
    routes: [
      { path: "/fraud", router: createFraudRouter(new FraudController(detection, projection)) },
    ],
    serviceName: "gaming-app-test",
  });
  return { app, detection, graph, names, projection, reports, source };
}

describe("FraudDetectionService", () => {
  let context = build();
  beforeEach(() => {
    context = build();
  });

  const ring = { boss: "p1", feederA: "p2", feederB: "p3", honest: "p4" };

  async function plantScenario(): Promise<void> {
    let n = 0;
    const id = (): string => `m-${String((n += 1)).padStart(4, "0")}`;
    // boss beats feederA 6 times and feederB 5 times, never loses to them
    for (let i = 0; i < 6; i++)
      context.source.matches.push(duel(id(), ring.boss, ring.feederA, i + 1));
    for (let i = 0; i < 5; i++)
      context.source.matches.push(duel(id(), ring.boss, ring.feederB, i + 1));
    // an honest rivalry: 4-4
    for (let i = 0; i < 4; i++)
      context.source.matches.push(duel(id(), ring.boss, ring.honest, i + 1));
    for (let i = 0; i < 4; i++)
      context.source.matches.push(duel(id(), ring.honest, ring.boss, i + 1));
    // old matches are outside the window
    for (let i = 0; i < 6; i++) context.source.matches.push(duel(id(), "p5", "p6", 60 + i));

    await context.projection.project({ afterId: null, limit: 1_000 });
    for (const [playerId, username] of [
      [ring.boss, "boss"],
      [ring.feederA, "feeder_a"],
      [ring.feederB, "feeder_b"],
    ] as const) {
      context.names.names.set(playerId, username);
    }
    const reportedAt = (minutesAgo: number): Date =>
      new Date(now.getTime() - minutesAgo * minuteMs);
    ["r1", "r2", "r3", "r4"].forEach((reporter, index) => {
      context.reports.reports.push({
        createdAt: reportedAt(30 - index * 5),
        id: randomUUID(),
        reportedPlayerId: ring.boss,
        reporterPlayerId: reporter,
      });
    });
    // an automatic report does not count as a reporter
    context.reports.reports.push({
      createdAt: reportedAt(1),
      id: randomUUID(),
      reportedPlayerId: "p9",
      reporterPlayerId: null,
    });
  }

  const criteria = {
    limit: 50,
    minBenefitRatio: 1,
    minMatches: 5,
    since: new Date(now.getTime() - 30 * dayMs),
  };

  it("finds the player who always beats the same opponents", async () => {
    await plantScenario();

    const result = await context.detection.detectMatchFixing(criteria);

    assert.equal(result.groups.length, 1);
    const [group] = result.groups;
    assert.equal(group?.beneficiary.playerId, ring.boss);
    assert.equal(group?.beneficiary.username, "boss");
    assert.deepEqual(
      group?.partners.map((partner) => [partner.username, partner.matches]),
      [
        ["feeder_a", 6],
        ["feeder_b", 5],
      ],
    );
  });

  it("applies the time window and the mode filter", async () => {
    await plantScenario();

    const wide = await context.detection.detectMatchFixing({
      ...criteria,
      since: new Date(now.getTime() - 90 * dayMs),
    });
    assert.equal(wide.groups.length, 2);

    const otherMode = await context.detection.detectMatchFixing({
      ...criteria,
      mode: "casual_5v5",
    });
    assert.deepEqual(otherMode.groups, []);
  });

  it("flags converging reports from distinct reporters and ignores automatic ones", async () => {
    await plantScenario();

    const result = await context.detection.detectCrossReports({
      minReporters: 3,
      since: new Date(now.getTime() - 30 * dayMs),
      windowMs: 60 * minuteMs,
    });

    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]?.reportedPlayerId, ring.boss);
    assert.equal(result.alerts[0]?.username, "boss");
    assert.equal(result.alerts[0]?.distinctReporters, 4);
    assert.equal(result.criteria.windowMinutes, 60);
  });

  it("cross-checks both signals", async () => {
    await plantScenario();

    const result = await context.detection.detectIrregularBehavior(criteria, {
      minReporters: 3,
      since: criteria.since,
      windowMs: 60 * minuteMs,
    });

    assert.deepEqual(result.playersInBoth, [ring.boss]);
  });

  it("projects idempotently and fails without side effects", async () => {
    await plantScenario();
    const before = context.graph.matches.size;

    await context.projection.project({ afterId: null, limit: 1_000 });
    assert.equal(context.graph.matches.size, before);

    await assert.rejects(
      requestContext.run({ failAt: "fraud.findOpposingPairs" }, () =>
        context.detection.detectMatchFixing(criteria),
      ),
      InjectedFailureError,
    );
    assert.equal(context.graph.matches.size, before);
  });
});

describe("fraud API", () => {
  let context = build();
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now });
    context = build();
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("GET /fraud/match-fixing uses the query parameters", async () => {
    for (let i = 0; i < 5; i++) context.source.matches.push(duel(`m-${String(i)}`, "a", "b", 1));
    await context.projection.project({ afterId: null, limit: 100 });

    const found = await request(context.app).get("/fraud/match-fixing?minMatches=5");
    const strict = await request(context.app).get("/fraud/match-fixing?minMatches=6");

    assert.equal(found.status, 200);
    assert.equal((found.body as MatchFixingResult).groups.length, 1);
    assert.equal((strict.body as MatchFixingResult).groups.length, 0);
  });

  it("GET /fraud/irregular-behavior answers with both signals", async () => {
    const response = await request(context.app).get("/fraud/irregular-behavior");
    const body = response.body as IrregularBehaviorResult;

    assert.equal(response.status, 200);
    assert.deepEqual(body.matchFixing.groups, []);
    assert.deepEqual(body.crossReports.alerts, []);
    assert.deepEqual(body.playersInBoth, []);
  });

  it("rejects invalid parameters and reports injected failures", async () => {
    const invalid = await request(context.app).get("/fraud/cross-reports?minReporters=1");
    const injected = await request(context.app)
      .get("/fraud/cross-reports")
      .set("x-fail-at", "fraud.findReportedByMany");

    assert.equal(invalid.status, 400);
    assert.equal(injected.status, 500);
    assert.deepEqual(injected.body, {
      error: "INJECTED_FAILURE",
      step: "fraud.findReportedByMany",
    });
  });
});
