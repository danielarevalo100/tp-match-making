import { randomUUID } from "node:crypto";

import type { HistoryRow } from "../../src/api/modules/playerHistory/business/models/playerHistory.js";
import { PlayerProfileService } from "../../src/api/modules/sanctions/business/services/playerProfileService.js";
import { SanctionService } from "../../src/api/modules/sanctions/business/services/sanctionService.js";
import type { SanctionInput } from "../../src/api/modules/sanctions/business/models/sanction.js";
import { InMemoryLeaderboardRanking } from "./inMemory/inMemoryLeaderboards.js";
import { InMemoryPlayerHistoryStore } from "./inMemory/inMemoryPlayerHistory.js";
import {
  InMemoryGraphCleanup,
  InMemoryHistoryCleanup,
  InMemoryProfileDirectory,
  InMemoryResultReversal,
  InMemorySanctionQueue,
  InMemorySanctionRepository,
} from "./inMemory/inMemorySanctions.js";

export const season = "2026-S2";
export const mode = "ranked_1v1";
export const boardKey = `${season}|${mode}`;

type Side = { delta: number; playerId: string; result: "win" | "loss" };

/**
 * State problem 4 leaves after three ranked matches, all in season 2026-S2 (every player starts at
 * 1500, +25 per win, -25 per loss):
 *
 *   m1  cheater wins against rival1   (cheated)
 *   m2  cheater wins against rival2   (cheated)
 *   m3  rival1 wins against cheater   (legit)
 *
 *   cheater 1525 (3 games)  rival1 1500 (2 games)  rival2 1475 (1 game)  bystander 1600 (4 games)
 *
 * The bystander never played them: it shares the board but must not be touched.
 */
export function buildSanctionScenario() {
  const ids = {
    administrator: randomUUID(),
    bystander: randomUUID(),
    cheater: randomUUID(),
    m1: randomUUID(),
    m2: randomUUID(),
    m3: randomUUID(),
    report: randomUUID(),
    rival1: randomUUID(),
    rival2: randomUUID(),
  };

  const repository = new InMemorySanctionRepository();
  const results = new InMemoryResultReversal();
  const queue = new InMemorySanctionQueue();
  const store = new InMemoryPlayerHistoryStore();
  const history = new InMemoryHistoryCleanup(store);
  const graph = new InMemoryGraphCleanup();
  const leaderboard = new InMemoryLeaderboardRanking();
  const directory = new InMemoryProfileDirectory();

  for (const playerId of [ids.cheater, ids.rival1, ids.rival2, ids.bystander]) {
    repository.players.add(playerId);
  }
  repository.administrators.set(ids.administrator, { active: true, id: ids.administrator });
  repository.reports.set(ids.report, {
    id: ids.report,
    matchId: ids.m1,
    reportedPlayerId: ids.cheater,
  });

  const matches: { id: string; sides: Side[]; tsMs: number }[] = [
    {
      id: ids.m1,
      sides: [
        { delta: 25, playerId: ids.cheater, result: "win" },
        { delta: -25, playerId: ids.rival1, result: "loss" },
      ],
      tsMs: Date.parse("2026-10-01T10:00:00Z"),
    },
    {
      id: ids.m2,
      sides: [
        { delta: 25, playerId: ids.cheater, result: "win" },
        { delta: -25, playerId: ids.rival2, result: "loss" },
      ],
      tsMs: Date.parse("2026-10-01T11:00:00Z"),
    },
    {
      id: ids.m3,
      sides: [
        { delta: -25, playerId: ids.cheater, result: "loss" },
        { delta: 25, playerId: ids.rival1, result: "win" },
      ],
      tsMs: Date.parse("2026-10-01T12:00:00Z"),
    },
  ];

  for (const match of matches) {
    results.matches.set(match.id, {
      createdAt: new Date(match.tsMs - 600_000),
      endedAt: new Date(match.tsMs),
      id: match.id,
      mode,
      participants: match.sides.map((side) => ({
        playerId: side.playerId,
        ratingDelta: side.delta,
      })),
      scoringStatus: "applied",
      status: "closed",
      voidedBySanctionId: null,
    });
    graph.matches.add(match.id);
    for (const side of match.sides) {
      results.applied.add(`${match.id}|${side.playerId}`);
      const row: HistoryRow = {
        deaths: 0,
        endedAt: new Date(match.tsMs),
        kills: side.result === "win" ? 1 : 0,
        matchId: match.id,
        mmrAfter: 0,
        mmrBefore: 0,
        mode,
        objectives: 0,
        playerId: side.playerId,
        ratingDelta: side.delta,
        region: "LATAM",
        result: side.result,
        score: 0,
      };
      store.rows.set(`${side.playerId}|${String(match.tsMs)}|${match.id}`, row);
    }
  }

  const players: [string, number, number, number, string][] = [
    [ids.cheater, 1_525, 3, 3, "LATAM"],
    [ids.rival1, 1_500, 2, 2, "LATAM"],
    [ids.rival2, 1_475, 1, 1, "NA"],
    [ids.bystander, 1_600, 4, 4, "LATAM"],
  ];
  for (const [playerId, mmr, gamesPlayed, revision, region] of players) {
    results.ratings.set(`${playerId}|${mode}`, { gamesPlayed, mmr });
    results.standings.set(`${season}|${mode}|${playerId}`, {
      gamesPlayed,
      mmr,
      playerId,
      region,
      revision,
    });
  }
  queue.queued.add(ids.cheater);

  const service = new SanctionService(repository, results, queue, history, graph, leaderboard);
  const profiles = new PlayerProfileService(directory, leaderboard, store);

  /** Problem 5's view of the board as it is right now (publishes what MongoDB holds). */
  const publishAll = async (): Promise<void> => {
    await leaderboard.publish(
      season,
      mode,
      players.map(([playerId]) => {
        const standing = results.standing(season, mode, playerId);
        if (!standing) throw new Error("missing standing");
        return standing;
      }),
    );
  };

  const input = (overrides: Partial<SanctionInput> = {}): SanctionInput => ({
    administratorId: ids.administrator,
    description: null,
    endsAt: null,
    matchIds: [ids.m1, ids.m2],
    playerId: ids.cheater,
    reason: "cheating",
    reportId: ids.report,
    sanctionId: randomUUID(),
    startsAt: null,
    type: "permanent_ban",
    ...overrides,
  });

  const boardMmr = (playerId: string): number | undefined =>
    leaderboard.standing(season, mode, playerId)?.mmr;

  return {
    boardMmr,
    directory,
    graph,
    history,
    ids,
    input,
    leaderboard,
    profiles,
    publishAll,
    queue,
    repository,
    results,
    service,
    store,
  };
}

export type SanctionScenario = ReturnType<typeof buildSanctionScenario>;
