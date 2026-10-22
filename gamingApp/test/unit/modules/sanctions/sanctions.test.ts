import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";

import {
  AdministratorNotActiveError,
  AdministratorNotFoundError,
  InvalidSanctionReportError,
  MatchNotReversibleError,
  SanctionConflictError,
  SanctionNotFoundError,
  SanctionPlayerNotFoundError,
} from "../../../../src/api/modules/sanctions/business/models/sanctionErrors.js";
import {
  affectedSeasons,
  heldBoards,
} from "../../../../src/api/modules/sanctions/business/services/reversalRules.js";
import { InjectedFailureError, type StorageEngine } from "../../../../src/shared/errors.js";
import { requestContext } from "../../../../src/shared/requestContext.js";
import { failOnce } from "../../../support/failOnce.js";
import {
  boardKey,
  buildSanctionScenario,
  mode,
  season,
} from "../../../support/sanctionScenario.js";

const withFailedDb = <T>(engine: StorageEngine, run: () => Promise<T>): Promise<T> =>
  requestContext.run({ failDb: engine }, run);

describe("SanctionService", () => {
  let context = buildSanctionScenario();
  beforeEach(async () => {
    context = buildSanctionScenario();
    await context.publishAll();
  });

  it("registers the sanction and voids every listed match in all the engines", async () => {
    const { ids, results } = context;
    const input = context.input();
    const outcome = await context.service.sanction(input);

    assert.equal(outcome.created, true);
    assert.equal(outcome.sanction.status, "active");
    assert.deepEqual(outcome.sanction.reversal.completedSteps, ["queue", "hold", "leaderboard"]);
    assert.equal(outcome.sanction.reversal.status, "completed");
    assert.deepEqual(outcome.sanction.reversal.pendingMatchIds, []);

    // MongoDB: partidas anuladas, el tramposo pierde lo que ganó y los rivales recuperan lo que perdieron.
    assert.equal(results.matches.get(ids.m1)?.status, "voided");
    assert.equal(results.matches.get(ids.m2)?.voidedBySanctionId, input.sanctionId);
    assert.equal(results.matches.get(ids.m3)?.status, "closed");
    assert.deepEqual(results.rating(ids.cheater, mode), { gamesPlayed: 1, mmr: 1_475 });
    assert.deepEqual(results.rating(ids.rival1, mode), { gamesPlayed: 1, mmr: 1_525 });
    assert.deepEqual(results.rating(ids.rival2, mode), { gamesPlayed: 0, mmr: 1_500 });
    assert.deepEqual(results.standing(season, mode, ids.cheater), {
      gamesPlayed: 1,
      mmr: 1_475,
      playerId: ids.cheater,
      region: "LATAM",
      revision: 5,
    });
    assert.equal(results.standing(season, mode, ids.bystander)?.revision, 4);

    // Cassandra y Neo4j: las partidas anuladas ya no están, la limpia queda.
    const historyMatches = [...context.store.rows.values()].map((row) => row.matchId);
    assert.equal(historyMatches.includes(ids.m1), false);
    assert.equal(historyMatches.includes(ids.m2), false);
    assert.equal(historyMatches.filter((matchId) => matchId === ids.m3).length, 2);
    assert.deepEqual([...context.graph.matches], [ids.m3]);

    // Redis: fuera de la cola, y el tablero muestra la reversión completa (a rival2 no le queda ninguna partida).
    assert.equal(context.queue.queued.has(ids.cheater), false);
    assert.equal(context.boardMmr(ids.cheater), 1_475);
    assert.equal(context.boardMmr(ids.rival1), 1_525);
    assert.equal(context.boardMmr(ids.rival2), undefined);
    assert.equal(context.boardMmr(ids.bystander), 1_600);
    assert.equal(context.leaderboard.releases, 1);
    assert.equal(context.leaderboard.held.get(boardKey)?.size ?? 0, 0);
  });

  it("treats a retry with the same id as the same sanction and never reverts twice", async () => {
    const input = context.input();
    await context.service.sanction(input);
    const reversals = context.results.ratingReversals;

    const replay = await context.service.sanction(input);

    assert.equal(replay.created, false);
    assert.equal(replay.sanction.reversal.status, "completed");
    assert.equal(context.results.ratingReversals, reversals);
    assert.equal(context.results.rating(context.ids.cheater, mode)?.mmr, 1_475);
    assert.equal(context.leaderboard.releases, 1);
  });

  it("rejects reusing a sanction id for different matches", async () => {
    const input = context.input();
    await context.service.sanction(input);

    await assert.rejects(
      context.service.sanction({ ...input, matchIds: [context.ids.m1] }),
      SanctionConflictError,
    );
  });

  it("validates everything before writing, so a rejected request leaves no trace", async () => {
    const { ids } = context;
    const cases: [Parameters<typeof context.input>[0], new (...args: never[]) => Error][] = [
      [{ playerId: randomUUID() }, SanctionPlayerNotFoundError],
      [{ administratorId: randomUUID() }, AdministratorNotFoundError],
      [{ reportId: randomUUID() }, InvalidSanctionReportError],
      [{ matchIds: [randomUUID()] }, MatchNotReversibleError],
      [{ matchIds: [ids.m1], playerId: ids.rival2, reportId: null }, MatchNotReversibleError],
    ];
    for (const [overrides, error] of cases) {
      await assert.rejects(context.service.sanction(context.input(overrides)), error);
    }

    context.repository.administrators.set(ids.administrator, {
      active: false,
      id: ids.administrator,
    });
    await assert.rejects(context.service.sanction(context.input()), AdministratorNotActiveError);

    assert.equal(context.repository.sanctions.size, 0);
    assert.equal(context.results.ratingReversals, 0);
  });

  it("refuses a match whose scoring problem 4 has not applied yet", async () => {
    const { ids, results } = context;
    const match = results.matches.get(ids.m2);
    if (!match) throw new Error("missing match");
    results.matches.set(ids.m2, { ...match, scoringStatus: "failed" });

    await assert.rejects(context.service.sanction(context.input()), (error: unknown) => {
      assert.ok(error instanceof MatchNotReversibleError);
      assert.equal(error.reason, "not_scored");
      return true;
    });
  });

  it("registers nothing when the failure happens before the sanction is written", async () => {
    await assert.rejects(
      withFailedDb("mongo", () => context.service.sanction(context.input())),
      InjectedFailureError,
    );

    assert.equal(context.repository.sanctions.size, 0);
    assert.equal(context.queue.queued.has(context.ids.cheater), true);
    assert.equal(context.results.matches.get(context.ids.m1)?.status, "closed");
  });

  it("keeps the sanction when the reversal fails, and holds the board until it completes", async () => {
    const { ids, results } = context;
    const input = context.input();
    results.failRevertOf = ids.m2;

    const failed = await context.service.sanction(input);

    // La sanción está registrada y en vigor; la reversión se frenó en la segunda partida.
    assert.equal(failed.created, true);
    assert.equal(failed.sanction.status, "active");
    assert.equal(failed.sanction.reversal.status, "failed");
    assert.match(failed.sanction.reversal.lastError ?? "", /reverting match/);
    assert.deepEqual(failed.sanction.reversal.revertedMatchIds, [ids.m1]);
    assert.deepEqual(failed.sanction.reversal.pendingMatchIds, [ids.m2]);
    assert.deepEqual(failed.sanction.reversal.completedSteps, ["queue", "hold"]);

    // MongoDB ya tiene revertida la primera partida...
    assert.equal(results.rating(ids.cheater, mode)?.mmr, 1_500);
    assert.equal(results.rating(ids.rival1, mode)?.mmr, 1_525);
    // ...pero el tablero no muestra nada de la reversión: todos los afectados siguen retenidos.
    assert.equal(context.boardMmr(ids.cheater), 1_525);
    assert.equal(context.boardMmr(ids.rival1), 1_500);
    assert.equal(context.boardMmr(ids.rival2), 1_475);

    // Una partida que se cierra mientras tanto (problema 4) publica lo que tiene MongoDB: los
    // retenidos se saltean y el resto del tablero sigue moviéndose.
    await context.publishAll();
    assert.equal(context.boardMmr(ids.rival1), 1_500);
    assert.equal(context.leaderboard.isHeld(boardKey, ids.bystander), false);

    // Reintentar completa la reversión desde donde se frenó.
    results.failRevertOf = null;
    const resumed = await context.service.resume(input.sanctionId);

    assert.equal(resumed.reversal.status, "completed");
    assert.equal(resumed.reversal.attempts, 2);
    assert.equal(results.rating(ids.cheater, mode)?.mmr, 1_475);
    assert.equal(results.rating(ids.rival2, mode)?.mmr, 1_500);
    assert.equal(context.boardMmr(ids.cheater), 1_475);
    assert.equal(context.boardMmr(ids.rival1), 1_525);
    assert.equal(context.boardMmr(ids.rival2), undefined);
    assert.equal(context.leaderboard.held.get(boardKey)?.size ?? 0, 0);
  });

  it("leaves the leaderboard untouched when its own publication fails, then publishes on retry", async () => {
    const { ids, results } = context;
    const input = context.input();

    failOnce(context.leaderboard, "release", "redis");
    const failed = await context.service.sanction(input);

    assert.equal(failed.sanction.reversal.status, "failed");
    assert.deepEqual(failed.sanction.reversal.revertedMatchIds, [ids.m1, ids.m2]);
    assert.equal(results.rating(ids.cheater, mode)?.mmr, 1_475);
    assert.equal(context.boardMmr(ids.cheater), 1_525);
    assert.equal(context.boardMmr(ids.rival2), 1_475);
    const reversals = results.ratingReversals;

    const retried = await context.service.sanction(input);

    assert.equal(retried.created, false);
    assert.equal(retried.sanction.reversal.status, "completed");
    assert.equal(results.ratingReversals, reversals);
    assert.equal(context.boardMmr(ids.cheater), 1_475);
    assert.equal(context.boardMmr(ids.rival2), undefined);
  });

  it("still publishes a match that closed while its player was held", async () => {
    const { ids, leaderboard, results } = context;
    const read = results.findStandings.bind(results);
    let reads = 0;
    results.findStandings = async (playerIds, seasonId, boardMode) => {
      const standings = await read(playerIds, seasonId, boardMode);
      reads += 1;
      const rival1 = results.standing(season, mode, ids.rival1);
      if (reads === 1 && rival1) {
        // Justo después de que el release leyó MongoDB, rival1 gana otra partida (problema 4)...
        const newer = {
          ...rival1,
          gamesPlayed: rival1.gamesPlayed + 1,
          mmr: rival1.mmr + 25,
          revision: rival1.revision + 1,
        };
        results.standings.set(`${season}|${mode}|${ids.rival1}`, newer);
        // ...y su publicación se saltea porque rival1 sigue retenido.
        await leaderboard.publish(season, mode, [newer]);
      }
      return standings;
    };

    await context.service.sanction(context.input());

    // m1 le devolvió a rival1 sus 25 (1525) y la nueva victoria suma 25 más.
    assert.equal(context.boardMmr(ids.rival1), 1_550);
    assert.equal(context.boardMmr(ids.cheater), 1_475);
  });

  it("records a failed queue removal and completes it on resume", async () => {
    const input = context.input();
    const failed = await withFailedDb("redis", () => context.service.sanction(input));

    assert.equal(failed.sanction.reversal.status, "failed");
    assert.deepEqual(failed.sanction.reversal.completedSteps, []);
    assert.equal(context.repository.sanctions.has(input.sanctionId), true);
    assert.equal(context.leaderboard.held.get(boardKey)?.size ?? 0, 0);

    const resumed = await context.service.resume(input.sanctionId);
    assert.equal(resumed.reversal.status, "completed");
    assert.equal(context.queue.queued.has(context.ids.cheater), false);
  });

  it("does not revert a match twice when two sanctions include it", async () => {
    const { ids, results } = context;
    await context.service.sanction(context.input({ matchIds: [ids.m1] }));
    const second = await context.service.sanction(context.input({ matchIds: [ids.m1, ids.m2] }));

    assert.equal(second.sanction.reversal.status, "completed");
    assert.equal(results.rating(ids.cheater, mode)?.mmr, 1_475);
    assert.equal(results.rating(ids.rival1, mode)?.mmr, 1_525);
    assert.equal(context.boardMmr(ids.cheater), 1_475);
  });

  it("returns and resumes a sanction by id", async () => {
    await assert.rejects(context.service.get(randomUUID()), SanctionNotFoundError);
    await assert.rejects(context.service.resume(randomUUID()), SanctionNotFoundError);

    const input = context.input();
    await context.service.sanction(input);
    const view = await context.service.get(input.sanctionId);
    assert.equal(view.sanctionId, input.sanctionId);
    assert.deepEqual(view.matchIds, [context.ids.m1, context.ids.m2]);
  });
});

describe("reversal rules", () => {
  const catalog = buildSanctionScenario().results.catalog;

  it("shifts the match's season and every later one, but only for ranked modes", () => {
    assert.deepEqual(affectedSeasons(catalog, mode, new Date("2026-05-10T00:00:00Z")), {
      matchSeasonId: "2026-S1",
      seasonIds: ["2026-S1", "2026-S2"],
    });
    assert.deepEqual(affectedSeasons(catalog, mode, new Date("2026-10-01T00:00:00Z")), {
      matchSeasonId: season,
      seasonIds: [season],
    });
    assert.deepEqual(affectedSeasons(catalog, "casual_5v5", new Date("2026-10-01T00:00:00Z")), {
      matchSeasonId: null,
      seasonIds: [],
    });
  });

  it("holds each affected board once, with every participant of its matches", () => {
    const { results, ids } = buildSanctionScenario();
    const matches = [ids.m1, ids.m2].flatMap((id) => results.matches.get(id) ?? []);
    const seasons = new Map(
      matches.map((match) => [match.id, affectedSeasons(catalog, match.mode, match.createdAt)]),
    );

    const boards = heldBoards(matches, seasons);

    assert.equal(boards.length, 1);
    assert.deepEqual(boards[0]?.playerIds, [ids.cheater, ids.rival1, ids.rival2].sort());
  });

  it("reverts a match of a closed season in that season and in the later ones", async () => {
    const context = buildSanctionScenario();
    const { ids, results } = context;
    // m1 ahora pertenece a 2026-S1, donde cheater y rival1 tienen standing.
    const m1 = results.matches.get(ids.m1);
    if (!m1) throw new Error("missing match");
    results.matches.set(ids.m1, { ...m1, createdAt: new Date("2026-05-10T00:00:00Z") });
    for (const [playerId, mmr] of [
      [ids.cheater, 1_525],
      [ids.rival1, 1_475],
    ] as const) {
      results.standings.set(`2026-S1|${mode}|${playerId}`, {
        gamesPlayed: 1,
        mmr,
        playerId,
        region: "LATAM",
        revision: 1,
      });
    }
    await context.publishAll();

    await context.service.sanction(context.input({ matchIds: [ids.m1] }));

    // S1: la única partida ya no está y se descuenta el delta.
    assert.equal(results.standing("2026-S1", mode, ids.cheater)?.gamesPlayed, 0);
    assert.equal(results.standing("2026-S1", mode, ids.cheater)?.mmr, 1_500);
    // S2 arrastra el delta (el MMR no se reinicia) pero conserva todas sus partidas.
    assert.equal(results.standing(season, mode, ids.cheater)?.mmr, 1_500);
    assert.equal(results.standing(season, mode, ids.cheater)?.gamesPlayed, 3);
    assert.equal(context.leaderboard.releases, 2);
  });
});

describe("PlayerProfileService", () => {
  it("joins profile, ratings, positions, sanctions and latest matches", async () => {
    const context = buildSanctionScenario();
    const { directory, ids } = context;
    await context.publishAll();
    const input = context.input();
    await context.service.sanction(input);
    directory.players.set(ids.cheater, {
      player: {
        accountStatus: "active",
        country: "AR",
        id: ids.cheater,
        level: 7,
        region: "LATAM",
        registeredAt: new Date("2026-01-02T00:00:00Z"),
        username: "cheater",
      },
      ratings: [{ gamesPlayed: 1, mmr: 1_475, mode }],
      standings: [
        { gamesPlayed: 1, mmr: 1_475, mode, region: "LATAM", seasonId: season },
        { gamesPlayed: 2, mmr: 1_490, mode, region: "LATAM", seasonId: "2026-S1" },
      ],
    });
    directory.sanctions.push({
      endsAt: null,
      reason: "cheating",
      reversalStatus: "completed",
      sanctionId: input.sanctionId,
      startsAt: new Date(Date.now() - 1_000),
      status: "active",
      type: "permanent_ban",
      voidedMatches: 2,
    });
    directory.sanctionOwners.set(input.sanctionId, ids.cheater);

    const profile = await context.profiles.profile(ids.cheater, 10);

    assert.equal(profile.player.username, "cheater");
    assert.equal(profile.seasonId, season);
    assert.deepEqual(profile.ratings, [{ gamesPlayed: 1, mmr: 1_475, mode }]);
    // Solo la temporada activa: bystander 1600, rival1 1525, cheater 1475 (rival2 salió).
    assert.equal(profile.leaderboards.length, 1);
    assert.deepEqual(profile.leaderboards[0]?.global, { position: 3, totalPlayers: 3 });
    assert.deepEqual(profile.leaderboards[0]?.regional, { position: 3, totalPlayers: 3 });
    assert.equal(profile.sanctions[0]?.inForce, true);
    // Las partidas anuladas salieron del historial; solo queda la limpia.
    assert.deepEqual(
      profile.recentMatches.map((match) => match.matchId),
      [ids.m3],
    );
  });

  it("rejects an unknown player", async () => {
    const context = buildSanctionScenario();
    await assert.rejects(context.profiles.profile(randomUUID(), 10), SanctionPlayerNotFoundError);
  });
});
