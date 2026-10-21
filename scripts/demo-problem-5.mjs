#!/usr/bin/env node
// Problem 5 demo: leaderboard queries (Redis sorted sets rank, MongoDB holds standings and profiles).
//
// Needs MongoDB (with the schema applied), Redis and gaming-app running, and the gamingApp
// dependencies installed (`pnpm install` in gamingApp): the script borrows the app's MongoDB and
// Redis drivers to seed players and to simulate losing the Redis boards. It:
//   1. seeds PLAYERS players with a season standing straight into MongoDB (bulk and reproducible:
//      same SEED, same ids and ratings; previous demo players are replaced)
//   2. rebuilds the Redis boards from MongoDB through the API
//   3. checks the top 100 (global and regional) and a player's position and neighbours, and
//      compares that position with one computed independently in MongoDB
//   4. measures the latency of both queries
//   5. compares the position operation on each engine: Redis ZREVRANK against a MongoDB count
//      over an index (the alternative the design rejects)
//   6. failures: an injected failure, and the Redis boards lost and rebuilt from MongoDB
//
//   node scripts/demo-problem-5.mjs
//
// Overrides (environment): APP_URL, MONGODB_URI, MONGODB_DB_NAME, REDIS_URL, PLAYERS (50000),
// REQUESTS (1000), CONCURRENCY (32), SEASON (2026-S2), MODE (ranked_1v1), SEED (5).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(new URL("../gamingApp/package.json", import.meta.url));
const { MongoClient } = require("mongodb");
const { Redis } = require("ioredis");

function readEnvFile() {
  for (const name of [".env", ".env.example"]) {
    try {
      const text = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
      return Object.fromEntries(
        text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#") && line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
    } catch {
      // Try the next file.
    }
  }
  return {};
}

const dotenv = readEnvFile();
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3001";
const MONGODB_URI =
  process.env.MONGODB_URI ??
  `mongodb://${encodeURIComponent(dotenv.MONGO_ROOT_USERNAME ?? "gaming_admin")}:` +
    `${encodeURIComponent(dotenv.MONGO_ROOT_PASSWORD ?? "change_me_local_only")}` +
    `@127.0.0.1:${dotenv.MONGO_PORT ?? 27017}/?authSource=admin`;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME ?? "gaming";
const REDIS_URL = process.env.REDIS_URL ?? `redis://127.0.0.1:${dotenv.REDIS_PORT ?? 6379}`;
const PLAYERS = Number(process.env.PLAYERS ?? 50_000);
const REQUESTS = Number(process.env.REQUESTS ?? 1_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const SEASON = process.env.SEASON ?? "2026-S2";
const MODE = process.env.MODE ?? "ranked_1v1";
const SEED = Number(process.env.SEED ?? 5);
const USERNAME_PREFIX = "p5_";

const REGIONS = {
  ASIA: ["CN", "IN", "JP", "KR", "SG"],
  BR: ["BR"],
  EU: ["DE", "ES", "FR", "GB", "IT", "NL", "PL", "PT", "SE"],
  LATAM: ["AR", "CL", "CO", "MX", "PE", "UY"],
  NA: ["US", "CA"],
  OCE: ["AU", "NZ"],
};

let failures = 0;
const ok = (message) => console.log(`  OK   ${message}`);
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL ${message}`);
};
const check = (actual, expected, message) =>
  actual === expected ? ok(`${message} (${actual})`) : fail(`${message}: expected ${expected}, got ${actual}`);

async function call(method, path, headers = {}) {
  const response = await fetch(`${APP_URL}${path}`, { headers, method });
  const text = await response.text();
  return { body: text ? JSON.parse(text) : null, status: response.status };
}

async function pool(items, limit, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const summary = (label, samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(
    `  ${label}: n=${sorted.length} p50=${percentile(sorted, 0.5).toFixed(2)}ms ` +
      `p95=${percentile(sorted, 0.95).toFixed(2)}ms p99=${percentile(sorted, 0.99).toFixed(2)}ms ` +
      `max=${(sorted.at(-1) ?? 0).toFixed(2)}ms`,
  );
  return sorted;
};

// Small seeded PRNG (mulberry32) so every run produces the same players.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function uuid(next) {
  const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((Math.floor(next() * 4) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function seedPlayers() {
  const next = random(SEED);
  const regionIds = Object.keys(REGIONS);
  const now = new Date();
  return Array.from({ length: PLAYERS }, (_, index) => {
    const region = regionIds[Math.floor(next() * regionIds.length)];
    const countries = REGIONS[region];
    // Roughly normal ratings around 1500: plenty of players share a rating, so ties are exercised.
    const gaussian = Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
    const mmr = Math.max(0, Math.round(1_500 + gaussian * 300));
    const gamesPlayed = 1 + Math.floor(next() * 120);
    return {
      _id: uuid(next),
      accountStatus: "active",
      country: countries[Math.floor(next() * countries.length)],
      email: `${USERNAME_PREFIX}${index}@example.com`,
      level: 1 + Math.floor(next() * 60),
      passwordHash: "seeded-player-without-login",
      ratings: { [MODE]: { gamesPlayed, mmr, updatedAt: now } },
      region,
      registeredAt: now,
      seasonRatings: { [SEASON]: { [MODE]: { gamesPlayed, mmr, region, revision: 1, updatedAt: now } } },
      updatedAt: now,
      username: `${USERNAME_PREFIX}${index}`,
    };
  });
}

const mongo = new MongoClient(MONGODB_URI, { appName: "demo-problem-5" });
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
await mongo.connect();
await redis.connect();
const players = mongo.db(MONGODB_DB_NAME).collection("players");
const standingPath = `seasonRatings.${SEASON}.${MODE}`;
const board = `/leaderboards/${MODE}/${SEASON}`;

try {
  console.log(`== 1. Seeding ${PLAYERS} players with a ${SEASON} / ${MODE} standing (seed ${SEED})`);
  let started = performance.now();
  const removed = await players.deleteMany({ username: { $regex: `^${USERNAME_PREFIX}` } });
  const seeded = seedPlayers();
  for (let start = 0; start < seeded.length; start += 5_000) {
    await players.insertMany(seeded.slice(start, start + 5_000), { ordered: false });
  }
  const ranked = await players.countDocuments({ [standingPath]: { $exists: true } });
  ok(`replaced ${removed.deletedCount} previous demo players, inserted ${seeded.length} in ${(performance.now() - started).toFixed(0)}ms`);
  console.log(`  MongoDB ranks ${ranked} players in ${SEASON} / ${MODE}`);

  console.log("\n== 2. Rebuilding the Redis boards from MongoDB");
  started = performance.now();
  let response = await call("POST", `${board}/rebuild`);
  check(response.status, 200, "rebuild answers 200");
  check(response.body.published, ranked, `every MongoDB standing was published (${(performance.now() - started).toFixed(0)}ms)`);
  console.log(`  removed from Redis because MongoDB no longer ranks them: ${response.body.removed}`);

  console.log("\n== 3. Checks");
  response = await call("GET", board);
  check(response.status, 200, "global top answers 200");
  check(response.body.entries.length, Math.min(100, ranked), "the global top has 100 entries");
  check(response.body.totalPlayers, ranked, "the board size matches MongoDB");
  const top = response.body.entries;
  check(
    top.every((entry, index) => entry.position === index + 1 && (index === 0 || top[index - 1].mmr >= entry.mmr)),
    true,
    "positions are 1..100 and ratings never increase",
  );
  check(top.every((entry) => typeof entry.username === "string"), true, "every entry has its username from MongoDB");

  const regionalCount = await players.countDocuments({ [`${standingPath}.region`]: "LATAM" });
  response = await call("GET", `${board}?region=LATAM`);
  check(response.body.totalPlayers, regionalCount, "the LATAM board has every LATAM player");
  check(response.body.entries.every((entry) => entry.region === "LATAM"), true, "the LATAM board only has LATAM players");

  const sample = seeded[Math.floor(seeded.length / 2)];
  response = await call("GET", `${board}/players/${sample._id}`);
  check(response.status, 200, "a player's position answers 200");
  const { above, below, player } = response.body;
  check(`${above.length}/${below.length}`, "5/5", "five neighbours above and five below");
  check(
    [...above, player, ...below].every((entry, index, all) => index === 0 || entry.position === all[index - 1].position + 1),
    true,
    "neighbour positions are consecutive",
  );
  // Same order as Redis: higher rating first, equal ratings by descending id.
  const independent =
    1 +
    (await players.countDocuments({
      $or: [
        { [`${standingPath}.mmr`]: { $gt: player.mmr } },
        { [`${standingPath}.mmr`]: player.mmr, _id: { $gt: sample._id } },
      ],
    }));
  check(player.position, independent, "the position matches a count computed in MongoDB");

  console.log("\n== 4. Latency through the API (validation in MongoDB + Redis query + MongoDB profiles)");
  const ids = seeded.map((entry) => entry._id);
  const samples = { position: [], regionalTop: [], top: [] };
  const kinds = Array.from({ length: REQUESTS }, (_, index) => ["top", "regionalTop", "position"][index % 3]);
  started = performance.now();
  await pool(kinds, CONCURRENCY, async (kind) => {
    const path =
      kind === "top"
        ? board
        : kind === "regionalTop"
          ? `${board}?region=EU`
          : `${board}/players/${ids[Math.floor(Math.random() * ids.length)]}`;
    const t0 = performance.now();
    const answer = await call("GET", path);
    samples[kind].push(performance.now() - t0);
    if (answer.status !== 200) fail(`${path} answered ${answer.status}`);
  });
  console.log(`  ${REQUESTS} requests with ${CONCURRENCY} in flight in ${(performance.now() - started).toFixed(0)}ms`);
  summary("global top 100   ", samples.top);
  summary("regional top 100 ", samples.regionalTop);
  summary("position + 5/5   ", samples.position);

  console.log("\n== 5. The position operation on each engine (players spread over the whole board)");
  const probes = Array.from({ length: 50 }, (_, index) => seeded[Math.floor((index * seeded.length) / 50)]);
  const globalKey = `lb:${SEASON}:${MODE}:global`;
  const redisTimes = [];
  for (const probe of probes) {
    const t0 = performance.now();
    await redis.zrevrank(globalKey, probe._id);
    redisTimes.push(performance.now() - t0);
  }
  const indexName = "demo_problem_5_rank";
  await players.createIndex({ [`${standingPath}.mmr`]: -1 }, { name: indexName });
  const mongoTimes = [];
  try {
    for (const probe of probes) {
      const mmr = probe.seasonRatings[SEASON][MODE].mmr;
      const t0 = performance.now();
      await players.countDocuments({ [`${standingPath}.mmr`]: { $gt: mmr } });
      mongoTimes.push(performance.now() - t0);
    }
  } finally {
    await players.dropIndex(indexName);
  }
  const redisSorted = summary("Redis ZREVRANK                  ", redisTimes);
  const mongoSorted = summary("MongoDB countDocuments (indexed)", mongoTimes);
  console.log(
    `  At ${ranked} players MongoDB is ~${(percentile(mongoSorted, 0.5) / Math.max(percentile(redisSorted, 0.5), 0.001)).toFixed(0)}x slower at the median, ` +
      "and its cost grows with the position (it walks the index up to the player); ZREVRANK is O(log N).",
  );

  console.log("\n== 6. Failures");
  console.log("  6a. Injected failure in the Redis query (x-fail-at: leaderboard.around)");
  response = await call("GET", `${board}/players/${sample._id}`, { "x-fail-at": "leaderboard.around" });
  check(`${response.status}/${response.body.error}`, "500/INJECTED_FAILURE", "the query fails and nothing is written");

  console.log("  6b. Redis loses the boards; MongoDB still has every standing");
  const keys = await redis.keys(`lb:${SEASON}:${MODE}:*`);
  if (keys.length > 0) await redis.del(...keys);
  response = await call("GET", board);
  check(response.body.totalPlayers, 0, "the board is empty after the loss");
  response = await call("POST", `${board}/rebuild`);
  check(response.body.published, ranked, "rebuild republishes every standing from MongoDB");
  response = await call("GET", `${board}/players/${sample._id}`);
  check(response.body.player?.position, player.position, "the player is back at the same position");
} finally {
  await mongo.close();
  redis.disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
