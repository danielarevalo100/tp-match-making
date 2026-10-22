#!/usr/bin/env node
// Demo del problema 5: consultas del leaderboard (Redis rankea con sorted sets, MongoDB guarda
// standings y perfiles).
//
// Necesita MongoDB (con el esquema aplicado), Redis y gaming-app corriendo, y las dependencias de
// gamingApp instaladas (`pnpm install` en gamingApp): el script usa los drivers de MongoDB y Redis
// de la app para cargar jugadores y simular la pérdida de los tableros de Redis. Hace:
//   1. carga PLAYERS jugadores con standing de temporada directo en MongoDB (masivo y
//      reproducible: misma SEED, mismos ids y ratings; reemplaza a los de corridas anteriores)
//   2. reconstruye los tableros de Redis desde MongoDB usando la API
//   3. controla el top 100 (global y regional) y la posición y vecinos de un jugador, y compara
//      esa posición con una calculada por separado en MongoDB
//   4. mide la latencia de las dos consultas
//   5. compara la operación de posición en cada base: ZREVRANK de Redis contra un count de
//      MongoDB sobre un índice (la alternativa que el diseño descarta)
//   6. fallas: una falla inyectada, y los tableros de Redis perdidos y reconstruidos desde MongoDB
//
//   node scripts/demo-problem-5.mjs
//
// Se puede cambiar (entorno): APP_URL, MONGODB_URI, MONGODB_DB_NAME, REDIS_URL, PLAYERS (50000),
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
      // Probar con el próximo archivo.
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

// PRNG chico con semilla (mulberry32), así cada corrida genera los mismos jugadores.
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
    // Ratings aproximadamente normales alrededor de 1500: muchos jugadores comparten rating, así se prueban los empates.
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
// La misma regla que la app: un standing sin partidas (el problema 8 anuló todas) no se rankea.
const ranked = { [`${standingPath}.gamesPlayed`]: { $gte: 1 } };
const board = `/leaderboards/${MODE}/${SEASON}`;

try {
  console.log(`== 1. Seeding ${PLAYERS} players with a ${SEASON} / ${MODE} standing (seed ${SEED})`);
  let started = performance.now();
  const removed = await players.deleteMany({ username: { $regex: `^${USERNAME_PREFIX}` } });
  const seeded = seedPlayers();
  for (let start = 0; start < seeded.length; start += 5_000) {
    await players.insertMany(seeded.slice(start, start + 5_000), { ordered: false });
  }
  const rankedCount = await players.countDocuments(ranked);
  ok(`replaced ${removed.deletedCount} previous demo players, inserted ${seeded.length} in ${(performance.now() - started).toFixed(0)}ms`);
  console.log(`  MongoDB ranks ${rankedCount} players in ${SEASON} / ${MODE}`);

  console.log("\n== 2. Rebuilding the Redis boards from MongoDB");
  started = performance.now();
  let response = await call("POST", `${board}/rebuild`);
  check(response.status, 200, "rebuild answers 200");
  check(response.body.published, rankedCount, `every MongoDB standing was published (${(performance.now() - started).toFixed(0)}ms)`);
  console.log(`  removed from Redis because MongoDB no longer ranks them: ${response.body.removed}`);

  console.log("\n== 3. Checks");
  response = await call("GET", board);
  check(response.status, 200, "global top answers 200");
  check(response.body.entries.length, Math.min(100, rankedCount), "the global top has 100 entries");
  check(response.body.totalPlayers, rankedCount, "the board size matches MongoDB");
  const top = response.body.entries;
  check(
    top.every((entry, index) => entry.position === index + 1 && (index === 0 || top[index - 1].mmr >= entry.mmr)),
    true,
    "positions are 1..100 and ratings never increase",
  );
  check(top.every((entry) => typeof entry.username === "string"), true, "every entry has its username from MongoDB");

  const regionalCount = await players.countDocuments({ ...ranked, [`${standingPath}.region`]: "LATAM" });
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
  // Mismo orden que Redis: primero el rating más alto, a igual rating por id descendente.
  const independent =
    1 +
    (await players.countDocuments({
      ...ranked,
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
    `  At ${rankedCount} players MongoDB is ~${(percentile(mongoSorted, 0.5) / Math.max(percentile(redisSorted, 0.5), 0.001)).toFixed(0)}x slower at the median, ` +
      "and its cost grows with the position (it walks the index up to the player); ZREVRANK is O(log N).",
  );

  console.log("\n== 6. Failures");
  console.log("  6a. Failure in the first Redis write of a rebuild (x-fail-db: redis)");
  const sizeBefore = (await call("GET", board)).body.totalPlayers;
  response = await call("POST", `${board}/rebuild`, { "x-fail-db": "redis" });
  check(`${response.status}/${response.body.error}`, "500/INJECTED_FAILURE", "the rebuild fails");
  check((await call("GET", board)).body.totalPlayers, sizeBefore, "and the board is unchanged");

  console.log("  6b. Redis loses the boards; MongoDB still has every standing");
  const keys = await redis.keys(`lb:${SEASON}:${MODE}:*`);
  if (keys.length > 0) await redis.del(...keys);
  response = await call("GET", board);
  check(response.body.totalPlayers, 0, "the board is empty after the loss");
  response = await call("POST", `${board}/rebuild`);
  check(response.body.published, rankedCount, "rebuild republishes every standing from MongoDB");
  response = await call("GET", `${board}/players/${sample._id}`);
  check(response.body.player?.position, player.position, "the player is back at the same position");
} finally {
  await mongo.close();
  redis.disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
