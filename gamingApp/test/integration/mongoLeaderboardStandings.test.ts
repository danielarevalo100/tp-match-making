import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { MongoLeaderboardAdapter } from "../../src/api/modules/leaderboards/infrastructure/adapters/mongoLeaderboardAdapter.js";
import { MongoMatchClosureAdapter } from "../../src/api/modules/matchClosure/infrastructure/adapters/mongoMatchClosureAdapter.js";
import { connectToMongo, type MongoConnection } from "../../src/infrastructure/mongo/mongoConnection.js";
import { mongoCollections } from "../../src/shared/storageKeys.js";

const mongoUri = process.env["MONGODB_URI"];

// Needs the schema and catalogs from infra/mongo/init.js: the validators check the documents the
// rating update produces, and `ranked_1v1` / the active `2026-S2` season decide the leaderboard.
describe("MongoDB season standings (real MongoDB)", { skip: mongoUri === undefined }, () => {
  let connection: MongoConnection;
  let closure: MongoMatchClosureAdapter;
  let leaderboard: MongoLeaderboardAdapter;
  const season = "2026-S2";
  const mode = "ranked_1v1";
  const playerId = randomUUID();
  const playedAt = new Date("2026-10-01T00:00:00Z");

  before(async () => {
    connection = await connectToMongo({
      appName: "gaming-app-test",
      attempts: 3,
      databaseName: process.env["MONGODB_DB_NAME"] ?? "gaming",
      delayMs: 500,
      uri: mongoUri as string,
    });
    closure = new MongoMatchClosureAdapter(connection.database);
    leaderboard = new MongoLeaderboardAdapter(connection.database);
    const now = new Date();
    await connection.database.collection(mongoCollections.players).insertOne({
      _id: playerId as never,
      accountStatus: "active",
      country: "AR",
      email: `${playerId}@example.com`,
      level: 1,
      passwordHash: "not-a-real-hash",
      ratings: { [mode]: { gamesPlayed: 0, mmr: 1_000, updatedAt: now } },
      region: "LATAM",
      registeredAt: now,
      updatedAt: now,
      username: `it_${playerId.slice(0, 8)}`,
    });
  });

  after(async () => {
    await connection.database.collection(mongoCollections.players).deleteOne({ _id: playerId as never });
    await connection.client.close();
  });

  it("finds the season of a ranked match and none for an unranked mode", async () => {
    assert.equal(await closure.findLeaderboardSeason(mode, playedAt), season);
    assert.equal(await closure.findLeaderboardSeason("casual_5v5", playedAt), null);
    assert.equal(await closure.findLeaderboardSeason(mode, new Date("2020-01-01T00:00:00Z")), null);
  });

  it("updates rating and season standing together, once per match", async () => {
    const firstMatch = randomUUID();
    const apply = (matchId: string, delta: number) =>
      closure.applyRating({
        at: new Date(),
        delta,
        fallbackMmr: 1_000,
        matchId,
        mode,
        playerId,
        seasonId: season,
      });

    await apply(firstMatch, 25);
    await apply(firstMatch, 25);
    assert.deepEqual(await closure.findStandings([playerId], mode, season), [
      { mmr: 1_025, playerId, region: "LATAM", revision: 1 },
    ]);

    await apply(randomUUID(), -25);
    assert.deepEqual(await leaderboard.findStandings([playerId], season, mode), [
      { mmr: 1_000, playerId, region: "LATAM", revision: 2 },
    ]);

    const summaries = await leaderboard.findPlayers([playerId], season, mode);
    assert.deepEqual(summaries.get(playerId), {
      country: "AR",
      gamesPlayed: 2,
      region: "LATAM",
      username: `it_${playerId.slice(0, 8)}`,
    });
  });

  it("lists the standings of a season and mode in batches", async () => {
    const seen: string[] = [];
    for await (const batch of leaderboard.listStandings(season, mode, 50)) {
      assert.ok(batch.length <= 50);
      seen.push(...batch.map((standing) => standing.playerId));
    }
    assert.ok(seen.includes(playerId));
  });

  it("reads the catalogs used to validate a board", async () => {
    assert.deepEqual(await leaderboard.findSeason(season), { id: season, status: "active" });
    assert.deepEqual(await leaderboard.findMode("casual_5v5"), { id: "casual_5v5", ranked: false });
    assert.equal(await leaderboard.regionExists("LATAM"), true);
    assert.equal(await leaderboard.regionExists("MARS"), false);
  });
});
