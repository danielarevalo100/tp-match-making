/**
 * Test data for problems 6 and 7 (player history and irregular behavior).
 *
 *   pnpm seed:history
 *
 * MongoDB is the source of truth: it gets players, closed matches (with the final scoreboard that
 * problem 4 would have written) and reports. Then the same projection services the API exposes
 * (POST /history/projection and POST /fraud/projection) load Cassandra and Neo4j from it.
 * Everything has a deterministic id, so running it again does not duplicate anything.
 *
 * Environment: SEED_PLAYERS (2000), SEED_MATCHES (50000), SEED_REPORTS (300), SEED_NOW (ISO date).
 * Needs the same variables as the application (see .env.example) and the schema applied.
 */
import { createHash } from "node:crypto";

import type { Collection } from "mongodb";

import { PlayerHistoryProjectionService } from "../api/modules/playerHistory/business/services/playerHistoryProjectionService.js";
import { FraudGraphProjectionService } from "../api/modules/fraudDetection/business/services/fraudGraphProjectionService.js";
import { Neo4jMatchGraphAdapter } from "../api/modules/fraudDetection/infrastructure/adapters/neo4jMatchGraphAdapter.js";
import { CassandraPlayerHistoryAdapter } from "../api/modules/playerHistory/infrastructure/adapters/cassandraPlayerHistoryAdapter.js";
import { MongoClosedMatchAdapter } from "../api/modules/playerHistory/infrastructure/adapters/mongoClosedMatchAdapter.js";
import { loadConfig } from "../config.js";
import { connectToCassandra } from "../infrastructure/cassandra/cassandraConnection.js";
import { connectToMongo } from "../infrastructure/mongo/mongoConnection.js";
import { connectToNeo4j } from "../infrastructure/neo4j/neo4jConnection.js";
import { hashPassword } from "../shared/password.js";
import { mongoCollections } from "../shared/storageKeys.js";

const mode = "ranked_1v1";
const dayMs = 86_400_000;
const minuteMs = 60_000;
const spanDays = 60;
const writeBatch = 1_000;
const countries = [
  ["AR", "LATAM"],
  ["CL", "LATAM"],
  ["MX", "LATAM"],
  ["BR", "BR"],
  ["US", "NA"],
  ["DE", "EU"],
  ["ES", "EU"],
  ["JP", "ASIA"],
] as const;
const reportReasons = ["cheating", "match_fixing", "toxicity", "griefing", "afk"] as const;

// mulberry32: small seeded generator, so the same seed gives the same data.
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Stable UUID for (kind, index): the same entity always gets the same id. */
function id(kind: string, index: number): string {
  const bytes = createHash("sha1")
    .update(`gaming-seed:${kind}:${String(index)}`)
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function intFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

type Fixture = { a: number; at: number; b: number; outcome: "a" | "b" | "draw" | null };

type Rating = { games: number; mmr: number };

async function upsertAll(
  collection: Collection<{ _id: string }>,
  documents: readonly { _id: string }[],
): Promise<void> {
  for (let start = 0; start < documents.length; start += writeBatch) {
    await collection.bulkWrite(
      documents.slice(start, start + writeBatch).map((document) => ({
        updateOne: {
          filter: { _id: document._id },
          update: { $setOnInsert: document },
          upsert: true,
        },
      })),
    );
  }
}

async function main(): Promise<void> {
  const playerCount = intFromEnv("SEED_PLAYERS", 2_000);
  const matchCount = intFromEnv("SEED_MATCHES", 50_000);
  const reportCount = intFromEnv("SEED_REPORTS", 300);
  if (playerCount < 150) throw new Error("SEED_PLAYERS must be at least 150.");
  const now = new Date(process.env["SEED_NOW"] ?? Date.now()).getTime();
  const random = createRandom(20_260_620);
  const between = (min: number, max: number): number =>
    min + Math.floor(random() * (max - min + 1));

  const config = loadConfig();
  const mongo = await connectToMongo({
    appName: "gaming-seed",
    attempts: config.mongoConnectRetries,
    databaseName: config.mongoDatabaseName,
    delayMs: config.mongoRetryDelayMs,
    uri: config.mongoUri,
  });
  const cassandra = await connectToCassandra({
    attempts: config.cassandraConnectRetries,
    contactPoints: config.cassandraContactPoints,
    delayMs: config.cassandraRetryDelayMs,
    keyspace: config.cassandraKeyspace,
    localDataCenter: config.cassandraLocalDataCenter,
    port: config.cassandraPort,
  });
  const neo4j = await connectToNeo4j({
    attempts: config.neo4jConnectRetries,
    database: config.neo4jDatabase,
    delayMs: config.neo4jRetryDelayMs,
    password: config.neo4jPassword,
    uri: config.neo4jUri,
    username: config.neo4jUsername,
  });

  try {
    // Fixtures: who plays whom and when. Planted scenarios have a fixed outcome.
    const fixtures: Fixture[] = [];
    const spread = (count: number, fromDaysAgo: number, toDaysAgo: number): number[] =>
      Array.from(
        { length: count },
        (_unused, index) =>
          now - (fromDaysAgo - ((fromDaysAgo - toDaysAgo) * (index + 0.5)) / count) * dayMs,
      );
    const plant = (
      a: number,
      b: number,
      wins: number,
      losses: number,
      from: number,
      to: number,
    ) => {
      const outcomes: ("a" | "b")[] = [
        ...Array.from({ length: wins }, () => "a" as const),
        ...Array.from({ length: losses }, () => "b" as const),
      ];
      // Interleave so the wins and losses are not in two blocks.
      outcomes.sort(() => random() - 0.5);
      spread(outcomes.length, from, to).forEach((at, index) =>
        fixtures.push({ a, at, b, outcome: outcomes[index] ?? "a" }),
      );
    };
    // Match-fixing ring: player 0 always beats players 1, 2 and 3.
    plant(0, 1, 8, 0, 14, 1);
    plant(0, 2, 7, 0, 14, 1);
    plant(0, 3, 6, 0, 14, 1);
    // Decoys: a one-sided rivalry (7-3), and always winning but only 3 matches.
    plant(10, 11, 7, 3, 20, 1);
    plant(12, 13, 3, 0, 10, 1);
    // An old ring, outside the default 30-day window.
    plant(20, 21, 6, 0, 50, 40);
    const planted = fixtures.length;
    // Players 0-21 only meet each other in the planted scenarios above.
    const reservedPlayers = 22;
    for (let index = 0; index < Math.max(0, matchCount - planted); index++) {
      const a = between(0, playerCount - 1);
      let b = between(0, playerCount - 1);
      if (b === a) b = (a + 1) % playerCount;
      if (a < reservedPlayers && b < reservedPlayers) b = between(reservedPlayers, playerCount - 1);
      fixtures.push({
        a,
        at: now - spanDays * dayMs + ((index + random()) / matchCount) * (spanDays - 0.1) * dayMs,
        b,
        outcome: null,
      });
    }
    for (const fixture of fixtures) fixture.at = Math.round(fixture.at);
    fixtures.sort((left, right) => left.at - right.at);

    // Simulate in order, so every player's mmrBefore/mmrAfter chain is consistent.
    const ratings: Rating[] = Array.from({ length: playerCount }, () => ({ games: 0, mmr: 1_000 }));
    const regionOf = (index: number): string => countries[index % countries.length]?.[1] ?? "NA";
    const matches = fixtures.map((fixture, index) => {
      const ra = ratings[fixture.a] as Rating;
      const rb = ratings[fixture.b] as Rating;
      const expectedA = 1 / (1 + 10 ** ((rb.mmr - ra.mmr) / 400));
      const draw = fixture.outcome === null && random() < 0.05;
      const aWins = fixture.outcome ? fixture.outcome === "a" : random() < expectedA;
      const results = draw
        ? (["draw", "draw"] as const)
        : aWins
          ? (["win", "loss"] as const)
          : (["loss", "win"] as const);
      const side = (player: number, rating: Rating, result: "win" | "loss" | "draw") => {
        const delta = result === "win" ? 25 : result === "loss" ? -25 : 0;
        const winner = result === "win";
        const kills = winner ? between(8, 20) : between(2, 12);
        const objectives = between(0, 3);
        const score = {
          deaths: winner ? between(2, 8) : between(6, 14),
          kills,
          mmrAfter: rating.mmr + delta,
          mmrBefore: rating.mmr,
          objectives,
          playerId: id("player", player),
          ratingDelta: delta,
          result,
          score: kills + objectives * 5,
        };
        rating.mmr += delta;
        rating.games += 1;
        return score;
      };
      const finalScoreboard = [side(fixture.a, ra, results[0]), side(fixture.b, rb, results[1])];
      const matchId = id("match", index);
      return {
        _id: matchId,
        closure: {
          completedAt: new Date(fixture.at),
          eventId: id("closure-event", index),
          id: id("closure", index),
          reason: "normal",
          requestedAt: new Date(fixture.at),
          results: finalScoreboard.map(({ playerId, result }) => ({ playerId, result })),
          tsMs: fixture.at,
        },
        createdAt: new Date(fixture.at - 15 * minuteMs),
        finalScoreboard,
        mode,
        players: finalScoreboard.map((score) => ({
          enqueuedAt: fixture.at - 20 * minuteMs,
          mmr: score.mmrBefore,
          playerId: score.playerId,
        })),
        ratingRange: 50,
        region: regionOf(fixture.a),
        scoringAttempts: 1,
        scoringStatus: "applied",
        scoringUpdatedAt: new Date(fixture.at),
        status: "closed",
      };
    });

    const passwordHash = await hashPassword("seed-password-123");
    const registeredAt = new Date(now - (spanDays + 30) * dayMs);
    const players = ratings.map((rating, index) => {
      const [country, region] = countries[index % countries.length] ?? ["US", "NA"];
      return {
        _id: id("player", index),
        accountStatus: "active",
        country,
        email: `seed_player_${String(index)}@seed.example`,
        level: 1 + Math.floor(rating.games / 10),
        passwordHash,
        ratings: {
          [mode]: { gamesPlayed: rating.games, mmr: rating.mmr, updatedAt: new Date(now) },
        },
        region,
        registeredAt,
        updatedAt: new Date(now),
        username: `seed_player_${String(index)}`,
      };
    });

    // Reports: planted scenarios plus random background noise.
    const reports: {
      _id: string;
      createdAt: Date;
      description: string;
      matchId: null;
      reason: string;
      reportedPlayerId: string;
      reporterPlayerId: string;
      status: string;
    }[] = [];
    const report = (reported: number, reporter: number, at: number, reason: string): void => {
      reports.push({
        _id: id("report", reports.length),
        createdAt: new Date(at),
        description: "seed data",
        matchId: null,
        reason,
        reportedPlayerId: id("player", reported),
        reporterPlayerId: id("player", reporter),
        status: "open",
      });
    };
    // Converging reports on the ring leader: 5 different reporters in 25 minutes.
    [100, 101, 102, 103, 104].forEach((reporter, index) =>
      report(0, reporter, now - 2 * dayMs + index * 6 * minuteMs, "match_fixing"),
    );
    // Another burst on a player that is not in any ring: 4 reporters in 40 minutes.
    [110, 111, 112, 113].forEach((reporter, index) =>
      report(40, reporter, now - 5 * dayMs + index * 13 * minuteMs, "toxicity"),
    );
    // Decoys: 5 reporters spread over 5 days, and one reporter filing 6 reports in 10 minutes.
    [120, 121, 122, 123, 124].forEach((reporter, index) =>
      report(30, reporter, now - (6 - index) * dayMs, "cheating"),
    );
    for (let index = 0; index < 6; index++)
      report(31, 130, now - 3 * dayMs + index * 2 * minuteMs, "cheating");
    for (let index = 0; index < reportCount; index++) {
      const reported = between(150, playerCount - 1);
      const reporter = (reported + between(1, playerCount - 1)) % playerCount;
      report(
        reported,
        reporter,
        now - between(0, spanDays * 1_440) * minuteMs,
        reportReasons[between(0, reportReasons.length - 1)] ?? "other",
      );
    }

    const database = mongo.database;
    console.log(`Writing ${String(players.length)} players to MongoDB...`);
    await upsertAll(database.collection<{ _id: string }>(mongoCollections.players), players);
    console.log(`Writing ${String(matches.length)} closed matches to MongoDB...`);
    await upsertAll(database.collection<{ _id: string }>(mongoCollections.matches), matches);
    console.log(`Writing ${String(reports.length)} reports to MongoDB...`);
    await upsertAll(database.collection<{ _id: string }>(mongoCollections.reports), reports);

    const source = new MongoClosedMatchAdapter(database);
    const everything = { afterId: null, limit: Number.MAX_SAFE_INTEGER };
    console.log("Projecting the history to Cassandra...");
    const history = await new PlayerHistoryProjectionService(
      source,
      new CassandraPlayerHistoryAdapter(cassandra),
    ).project(everything);
    console.log(`  ${String(history.matches)} matches, ${String(history.rows)} rows`);
    console.log("Projecting the graph to Neo4j...");
    const graph = await new FraudGraphProjectionService(
      source,
      new Neo4jMatchGraphAdapter(neo4j),
    ).project(everything);
    console.log(`  ${String(graph.matches)} matches, ${String(graph.rows)} relationships`);

    console.log("\nPlanted cases (players are seed_player_<n>):");
    console.log(`  match fixing ring : seed_player_0 beats 1, 2, 3     (${id("player", 0)})`);
    console.log("  not flagged       : 10 vs 11 (7-3), 12 vs 13 (3 matches), 20 vs 21 (old)");
    console.log(
      "  report burst      : seed_player_0 (5 reporters / 25 min), seed_player_40 (4 / 40 min)",
    );
    console.log(
      "  not flagged       : seed_player_30 (spread over days), seed_player_31 (one reporter)",
    );
    console.log(`\nTry: GET /history/players/${id("player", 0)}`);
    console.log("     GET /fraud/irregular-behavior");
  } finally {
    await Promise.allSettled([mongo.client.close(), cassandra.shutdown(), neo4j.driver.close()]);
  }
}

void main().catch((error: unknown) => {
  console.error("Seed failed", error);
  process.exit(1);
});
