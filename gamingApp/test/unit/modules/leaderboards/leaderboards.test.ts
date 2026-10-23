import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "../../../../src/api/app.js";
import type {
  LeaderboardPosition,
  LeaderboardTop,
} from "../../../../src/api/modules/leaderboards/business/models/leaderboard.js";
import { LeaderboardService } from "../../../../src/api/modules/leaderboards/business/services/leaderboardService.js";
import { LeaderboardController } from "../../../../src/api/modules/leaderboards/presentation/controllers/leaderboardController.js";
import { createLeaderboardRouter } from "../../../../src/api/modules/leaderboards/presentation/routers/leaderboardRouter.js";
import {
  InMemoryLeaderboardDirectory,
  InMemoryLeaderboardRanking,
} from "../../../support/inMemory/inMemoryLeaderboards.js";

const season = "2026-S2";
const mode = "ranked_1v1";
const regions = ["NA", "LATAM", "EU"] as const;
/** Key of the season and mode in the in-memory ranking (its rebuild lock, boards...). */
const boardKey = `${season}|${mode}`;

/** Deterministic ids so ties between equal ratings have a known order. */
function playerId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function build(players = 150) {
  const ranking = new InMemoryLeaderboardRanking();
  const directory = new InMemoryLeaderboardDirectory();
  const standings = Array.from({ length: players }, (_, index) => ({
    // Player 0 has the best rating; every rating is distinct.
    mmr: 3_000 - index * 10,
    playerId: playerId(index),
    region: regions[index % regions.length] as string,
    revision: 1,
  }));
  for (const standing of standings) {
    directory.addStanding(season, mode, standing, { gamesPlayed: 3 });
  }
  const service = new LeaderboardService(ranking, directory);
  const app = createApp({
    checkReadiness: async () => true,
    routes: [
      {
        path: "/leaderboards",
        router: createLeaderboardRouter(new LeaderboardController(service)),
      },
    ],
    serviceName: "gaming-app-test",
  });
  return { app, directory, ranking, service, standings };
}

describe("LeaderboardService", () => {
  let context = build();
  beforeEach(async () => {
    context = build();
    await context.ranking.publish(season, mode, context.standings);
  });

  it("returns the global top 100 with profile data from the directory", async () => {
    const top = await context.service.top({ mode, region: null, seasonId: season });

    assert.equal(top.totalPlayers, 150);
    assert.equal(top.entries.length, 100);
    assert.equal(top.scope, "global");
    assert.equal(top.seasonStatus, "active");
    assert.deepEqual(top.entries[0], {
      country: "US",
      gamesPlayed: 3,
      mmr: 3_000,
      playerId: playerId(0),
      position: 1,
      region: "NA",
      username: `player_${playerId(0).slice(0, 8)}`,
    });
    assert.equal(top.entries[99]?.position, 100);
    assert.equal(top.entries[99]?.playerId, playerId(99));
  });

  it("ranks a regional board with its own positions", async () => {
    const top = await context.service.top({ mode, region: "LATAM", seasonId: season });

    assert.equal(top.scope, "regional");
    assert.equal(top.totalPlayers, 50);
    assert.equal(top.entries[0]?.playerId, playerId(1));
    assert.equal(top.entries[1]?.playerId, playerId(4));
    assert.ok(top.entries.every((entry) => entry.region === "LATAM"));
  });

  it("returns the player with five neighbours above and below", async () => {
    const position = await context.service.position(
      { mode, region: null, seasonId: season },
      playerId(50),
    );

    assert.equal(position.player.position, 51);
    assert.deepEqual(
      position.above.map((entry) => entry.position),
      [46, 47, 48, 49, 50],
    );
    assert.deepEqual(
      position.below.map((entry) => entry.position),
      [52, 53, 54, 55, 56],
    );
  });

  it("trims the window at the edges of the board", async () => {
    const first = await context.service.position(
      { mode, region: null, seasonId: season },
      playerId(0),
    );
    assert.equal(first.player.position, 1);
    assert.equal(first.above.length, 0);
    assert.equal(first.below.length, 5);

    const last = await context.service.position(
      { mode, region: null, seasonId: season },
      playerId(149),
    );
    assert.equal(last.player.position, 150);
    assert.equal(last.above.length, 5);
    assert.equal(last.below.length, 0);
  });

  it("orders equal ratings by descending player id, like Redis", async () => {
    await context.ranking.publish(season, mode, [
      { mmr: 5_000, playerId: playerId(200), region: "EU", revision: 1 },
      { mmr: 5_000, playerId: playerId(201), region: "EU", revision: 1 },
    ]);
    const top = await context.service.top({ mode, region: null, seasonId: season });

    assert.equal(top.entries[0]?.playerId, playerId(201));
    assert.equal(top.entries[1]?.playerId, playerId(200));
  });

  it("rejects a player who is not in the requested board", async () => {
    await assert.rejects(
      context.service.position({ mode, region: "EU", seasonId: season }, playerId(1)),
      {
        name: "PlayerNotRankedError",
      },
    );
  });

  it("rejects unknown seasons, modes and regions, and unranked modes", async () => {
    await assert.rejects(context.service.top({ mode, region: null, seasonId: "1999-S1" }), {
      name: "LeaderboardNotFoundError",
    });
    await assert.rejects(context.service.top({ mode: "nope", region: null, seasonId: season }), {
      name: "LeaderboardNotFoundError",
    });
    await assert.rejects(context.service.top({ mode, region: "MARS", seasonId: season }), {
      name: "LeaderboardNotFoundError",
    });
    await assert.rejects(
      context.service.top({ mode: "casual_5v5", region: null, seasonId: season }),
      {
        name: "ModeNotRankedError",
      },
    );
  });

  it("rebuilds the board from the directory and removes players it no longer ranks", async () => {
    context.ranking.boards.clear();
    await context.ranking.publish(season, mode, [
      { mmr: 9_999, playerId: playerId(999), region: "NA", revision: 1 },
    ]);

    const result = await context.service.rebuild(season, mode);

    assert.deepEqual(result, { mode, published: 150, removed: 1, seasonId: season });
    const top = await context.service.top({ mode, region: null, seasonId: season });
    assert.equal(top.totalPlayers, 150);
    assert.equal(top.entries[0]?.playerId, playerId(0));
  });

  it("rejects a rebuild while another one holds the board's lock", async () => {
    context.ranking.rebuildLocks.set(boardKey, "another-instance");

    await assert.rejects(context.service.rebuild(season, mode), {
      name: "LeaderboardRebuildInProgressError",
    });
    assert.equal(context.ranking.rebuildLocks.get(boardKey), "another-instance");

    context.ranking.rebuildLocks.delete(boardKey);
    assert.equal((await context.service.rebuild(season, mode)).published, 150);
    assert.equal(context.ranking.rebuildLocks.size, 0);
  });

  it("stops a rebuild whose lock another rebuild took over", async () => {
    const publish = context.ranking.publish.bind(context.ranking);
    context.ranking.publish = async (...args) => {
      await publish(...args);
      // The lock expired mid-rebuild and another instance took it.
      context.ranking.rebuildLocks.set(boardKey, "another-instance");
    };

    await assert.rejects(context.service.rebuild(season, mode), {
      name: "LeaderboardRebuildInProgressError",
    });
    assert.equal(context.ranking.rebuildLocks.get(boardKey), "another-instance");
  });
});

describe("LeaderboardService lazy reload", () => {
  let context = build();
  beforeEach(async () => {
    context = build();
    await context.ranking.publish(season, mode, context.standings);
    // Redis came back empty: MongoDB still ranks the 150 players.
    context.ranking.boards.clear();
    context.ranking.publications = 0;
  });

  it("reloads an empty board from MongoDB on the first read", async () => {
    const top = await context.service.top({ mode, region: null, seasonId: season });

    assert.equal(top.totalPlayers, 150);
    assert.equal(top.entries[0]?.playerId, playerId(0));
    assert.equal(context.ranking.publications, 1);
    assert.equal(context.ranking.rebuildLocks.size, 0);

    await context.service.top({ mode, region: null, seasonId: season });
    assert.equal(context.ranking.publications, 1);
  });

  it("reloads before answering a position or a regional board", async () => {
    const position = await context.service.position(
      { mode, region: null, seasonId: season },
      playerId(10),
    );
    assert.equal(position.player.position, 11);

    context.ranking.boards.clear();
    const regional = await context.service.top({ mode, region: "EU", seasonId: season });
    assert.equal(regional.totalPlayers, 50);
  });

  it("leaves the board alone when MongoDB ranks nobody either", async () => {
    context.directory.players.clear();

    const top = await context.service.top({ mode, region: null, seasonId: season });

    assert.equal(top.totalPlayers, 0);
    assert.equal(context.ranking.publications, 0);
  });

  it("does not reload a board that still has players", async () => {
    await context.ranking.publish(season, mode, context.standings);
    context.ranking.publications = 0;

    await assert.rejects(
      context.service.position({ mode, region: null, seasonId: season }, playerId(500)),
      { name: "PlayerNotRankedError" },
    );
    assert.equal(context.ranking.publications, 0);
  });

  it("rebuilds once when several readers find the board empty at the same time", async () => {
    const service = new LeaderboardService(context.ranking, context.directory, {
      pollMs: 5,
      waitMs: 1_000,
    });

    const tops = await Promise.all(
      Array.from({ length: 5 }, () => service.top({ mode, region: null, seasonId: season })),
    );

    assert.deepEqual(
      tops.map((top) => top.totalPlayers),
      [150, 150, 150, 150, 150],
    );
    assert.equal(context.ranking.publications, 1);
  });

  it("waits for a reload another instance is running", async () => {
    const service = new LeaderboardService(context.ranking, context.directory, {
      pollMs: 5,
      waitMs: 1_000,
    });
    context.ranking.rebuildLocks.set(boardKey, "another-instance");
    setTimeout(() => {
      void context.ranking.publish(season, mode, context.standings).then(() => {
        context.ranking.rebuildLocks.delete(boardKey);
      });
    }, 30);

    const top = await service.top({ mode, region: null, seasonId: season });

    assert.equal(top.totalPlayers, 150);
    assert.equal(context.ranking.publications, 1);
  });

  it("gives up when the other reload takes too long", async () => {
    const service = new LeaderboardService(context.ranking, context.directory, {
      pollMs: 5,
      waitMs: 30,
    });
    context.ranking.rebuildLocks.set(boardKey, "another-instance");

    await assert.rejects(service.top({ mode, region: null, seasonId: season }), {
      name: "LeaderboardRebuildInProgressError",
    });
  });
});

describe("leaderboards API", () => {
  let context = build();
  beforeEach(async () => {
    context = build();
    await context.ranking.publish(season, mode, context.standings);
  });

  it("serves the top 100 of a season and mode", async () => {
    const response = await request(context.app).get(`/leaderboards/${mode}/${season}`);

    assert.equal(response.status, 200);
    const body = response.body as LeaderboardTop;
    assert.equal(body.entries.length, 100);
    assert.equal(body.totalPlayers, 150);
  });

  it("normalizes the region of a regional board", async () => {
    const response = await request(context.app).get(`/leaderboards/${mode}/${season}?region=latam`);

    assert.equal(response.status, 200);
    assert.equal((response.body as LeaderboardTop).region, "LATAM");
  });

  it("serves a player's position with neighbours", async () => {
    const response = await request(context.app).get(
      `/leaderboards/${mode}/${season}/players/${playerId(10)}`,
    );

    assert.equal(response.status, 200);
    const body = response.body as LeaderboardPosition;
    assert.equal(body.player.position, 11);
    assert.equal(body.above.length, 5);
    assert.equal(body.below.length, 5);
  });

  it("maps errors to HTTP statuses", async () => {
    const unranked = await request(context.app).get(
      `/leaderboards/${mode}/${season}/players/${playerId(500)}`,
    );
    assert.equal(unranked.status, 404);
    assert.equal((unranked.body as { error: string }).error, "PLAYER_NOT_RANKED");

    const missingSeason = await request(context.app).get(`/leaderboards/${mode}/2001-S1`);
    assert.equal(missingSeason.status, 404);
    assert.equal((missingSeason.body as { missing: string }).missing, "season");

    const casual = await request(context.app).get(`/leaderboards/casual_5v5/${season}`);
    assert.equal(casual.status, 422);

    const invalid = await request(context.app).get(`/leaderboards/${mode}/${season}?region=n-a`);
    assert.equal(invalid.status, 400);

    const unknownQuery = await request(context.app).get(`/leaderboards/${mode}/${season}?top=5`);
    assert.equal(unknownQuery.status, 400);
  });

  it("rebuilds through the API", async () => {
    const response = await request(context.app).post(`/leaderboards/${mode}/${season}/rebuild`);

    assert.equal(response.status, 200);
    assert.equal((response.body as { published: number }).published, 150);
  });

  it("answers 409 while the board is being rebuilt", async () => {
    context.ranking.rebuildLocks.set(boardKey, "another-instance");

    const response = await request(context.app).post(`/leaderboards/${mode}/${season}/rebuild`);

    assert.equal(response.status, 409);
    assert.equal((response.body as { error: string }).error, "LEADERBOARD_REBUILD_IN_PROGRESS");
  });

  it("frees the rebuild lock when the rebuild fails", async () => {
    const failed = await request(context.app)
      .post(`/leaderboards/${mode}/${season}/rebuild`)
      .set("x-fail-at", "leaderboard.publish");

    assert.equal(failed.status, 500);
    assert.equal(context.ranking.rebuildLocks.size, 0);
  });
});
