#!/usr/bin/env node
// Demo del problema 8: sanción con reversión de resultados, y el perfil del jugador en todas las bases.
//
// Necesita todo el stack de Compose (MongoDB con el esquema aplicado, Redis, Cassandra, Neo4j y
// gaming-app) y las dependencias de gamingApp instaladas (`pnpm install` en gamingApp): el script
// usa los drivers de MongoDB y Redis de la app para cargar el estado inicial y mostrar qué tiene
// cada base. Hace:
//   1. carga tres jugadores y tres partidas rankeadas cerradas tal como las deja el problema 4
//      (ratings aplicados, standings de temporada, marcadores finales), más un administrador y un
//      reporte, y las proyecta al historial (problema 6), al grafo (problema 7) y al leaderboard
//      (problema 5) usando la API
//   2. sanciona al tramposo por las partidas 1 y 2 con una falla de Cassandra en la primera: la
//      sanción está en vigor, MongoDB tiene la partida 1 revertida, pero el leaderboard no muestra
//      nada de eso
//   3. un rebuild del leaderboard con la reversión incompleta no puede publicar a los retenidos
//   4. resume completa la reversión: ratings, historial y leaderboard la muestran de una vez
//   5. los reintentos no cambian nada, una falla antes de registrar no deja sanción, los pedidos
//      inválidos se rechazan, y el jugador sancionado no puede entrar a la cola
//
//   node scripts/demo-problem-8.mjs
//
// Se puede cambiar (entorno): APP_URL, MONGODB_URI, MONGODB_DB_NAME, REDIS_URL, MODE (ranked_1v1).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

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
const MODE = process.env.MODE ?? "ranked_1v1";

let failures = 0;
const ok = (message) => console.log(`  OK   ${message}`);
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL ${message}`);
};
const check = (actual, expected, message) =>
  actual === expected
    ? ok(`${message} (${actual})`)
    : fail(`${message}: expected ${expected}, got ${actual}`);

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method,
  });
  const text = await response.text();
  return { body: text ? JSON.parse(text) : null, status: response.status };
}

const mongo = new MongoClient(MONGODB_URI, { appName: "demo-problem-8" });
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
await mongo.connect();
await redis.connect();
const db = mongo.db(MONGODB_DB_NAME);

try {
  const season = await db.collection("seasons").findOne({ status: "active" });
  const now = new Date();
  if (!season || season.startsAt > now || season.endsAt < now) {
    throw new Error("There is no active season containing today; the matches would not be ranked.");
  }
  const SEASON = season._id;
  const board = `/leaderboards/${MODE}/${SEASON}`;
  const run = randomUUID().slice(0, 8);

  console.log(`== 1. Seeding the state problem 4 leaves (run ${run}, ${SEASON} / ${MODE})`);
  const ids = {
    administrator: randomUUID(),
    cheater: randomUUID(),
    m1: randomUUID(),
    m2: randomUUID(),
    m3: randomUUID(),
    report: randomUUID(),
    rival1: randomUUID(),
    rival2: randomUUID(),
  };
  // Todos empiezan en 1500: en m1 el tramposo le gana a rival1, en m2 a rival2 (las dos con
  // trampa), y en m3 rival1 le gana al tramposo (limpia). Rival2 juega desde NA, el resto desde LATAM.
  const matches = [
    { id: ids.m1, sides: [[ids.cheater, "win", 25, 1_500], [ids.rival1, "loss", -25, 1_500]] },
    { id: ids.m2, sides: [[ids.cheater, "win", 25, 1_525], [ids.rival2, "loss", -25, 1_500]] },
    { id: ids.m3, sides: [[ids.cheater, "loss", -25, 1_550], [ids.rival1, "win", 25, 1_475]] },
  ];
  const players = [
    [ids.cheater, "cheater", "AR", "LATAM", 1_525, 3, [ids.m1, ids.m2, ids.m3]],
    [ids.rival1, "rival1", "AR", "LATAM", 1_500, 2, [ids.m1, ids.m3]],
    [ids.rival2, "rival2", "US", "NA", 1_475, 1, [ids.m2]],
  ];
  await db.collection("players").insertMany(
    players.map(([_id, name, country, region, mmr, gamesPlayed, applied]) => ({
      _id,
      accountStatus: "active",
      appliedRatingMatches: applied,
      country,
      email: `p8_${name}_${run}@example.com`,
      level: 10,
      passwordHash: "seeded-player-without-login",
      ratings: { [MODE]: { gamesPlayed, mmr, updatedAt: now } },
      region,
      registeredAt: now,
      seasonRatings: {
        [SEASON]: { [MODE]: { gamesPlayed, mmr, region, revision: gamesPlayed, updatedAt: now } },
      },
      updatedAt: now,
      username: `p8_${name}_${run}`,
    })),
  );
  await db.collection("matches").insertMany(
    matches.map((match, index) => {
      const tsMs = now.getTime() - (matches.length - index) * 60_000;
      return {
        _id: match.id,
        closure: {
          completedAt: new Date(tsMs),
          eventId: randomUUID(),
          id: randomUUID(),
          reason: "normal",
          requestedAt: new Date(tsMs),
          results: match.sides.map(([playerId, result]) => ({ playerId, result })),
          tsMs,
        },
        createdAt: new Date(tsMs - 600_000),
        finalScoreboard: match.sides.map(([playerId, result, delta, mmrBefore]) => ({
          deaths: result === "win" ? 0 : 1,
          kills: result === "win" ? 1 : 0,
          mmrAfter: mmrBefore + delta,
          mmrBefore,
          objectives: 0,
          playerId,
          ratingDelta: delta,
          result,
          score: result === "win" ? 1 : 0,
        })),
        leaderboard: { status: "published", updatedAt: new Date(tsMs) },
        mode: MODE,
        players: match.sides.map(([playerId, , , mmr], order) => ({
          enqueuedAt: tsMs - 700_000 + order,
          mmr,
          playerId,
        })),
        ratingRange: 150,
        region: "LATAM",
        scoringStatus: "applied",
        status: "closed",
      };
    }),
  );
  await db.collection("administrators").insertOne({
    _id: ids.administrator,
    active: true,
    createdAt: now,
    email: `p8_admin_${run}@example.com`,
    permissionLevel: "admin",
    username: `p8_admin_${run}`,
  });
  await db.collection("reports").insertOne({
    _id: ids.report,
    createdAt: now,
    matchId: ids.m1,
    reason: "cheating",
    reportedPlayerId: ids.cheater,
    reporterPlayerId: ids.rival1,
    status: "open",
  });
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  let response = await call("POST", "/history/projection", { since });
  check(response.status, 200, "matches projected to the Cassandra history");
  response = await call("POST", "/fraud/projection", { since });
  check(response.status, 200, "matches projected to the Neo4j graph");
  response = await call("POST", `${board}/rebuild`);
  check(response.status, 200, "leaderboard rebuilt from MongoDB");

  response = await call("GET", `/profiles/${ids.cheater}`);
  check(response.status, 200, "GET /profiles answers 200");
  check(response.body.recentMatches.length, 3, "the cheater has 3 matches in its history");
  check(response.body.leaderboards[0]?.mmr, 1_525, "and 1525 in the leaderboard");

  const sanction = {
    administratorId: ids.administrator,
    matchIds: [ids.m1, ids.m2],
    playerId: ids.cheater,
    reason: "cheating",
    reportId: ids.report,
    sanctionId: randomUUID(),
    type: "permanent_ban",
  };
  const playersCollection = db.collection("players");
  const mmrOf = async (playerId) =>
    (await playersCollection.findOne({ _id: playerId })).ratings[MODE].mmr;
  const boardMmr = async (playerId) => {
    const position = await call("GET", `${board}/players/${playerId}`);
    return position.status === 200 ? position.body.player.mmr : position.body.error;
  };

  console.log("\n== 2. Sanction with a Cassandra failure in the first match (x-fail-db: cassandra)");
  response = await call("POST", "/sanctions", sanction, { "x-fail-db": "cassandra" });
  check(response.status, 202, "202: the sanction is registered, the reversal is incomplete");
  check(response.body.status, "active", "the sanction is in force");
  check(response.body.reversal.status, "failed", "the reversal is recorded as failed");
  check(response.body.reversal.completedSteps.join(","), "queue,hold", "steps in the journal");
  check(
    (await db.collection("matches").findOne({ _id: ids.m1 })).status,
    "voided",
    "MongoDB: match 1 is voided",
  );
  check(await mmrOf(ids.cheater), 1_500, "MongoDB: the cheater already lost match 1's +25");
  check(await boardMmr(ids.cheater), 1_525, "Redis: the leaderboard still shows 1525 (held)");
  check(await boardMmr(ids.rival1), 1_500, "Redis: rival1 still shows 1500 (held)");
  check(
    await redis.hget(`lb:${SEASON}:${MODE}:held`, ids.cheater),
    "1",
    "Redis: the cheater is held by one reversal",
  );

  console.log("\n== 3. A leaderboard rebuild while the reversal is incomplete");
  response = await call("POST", `${board}/rebuild`);
  check(response.status, 200, "rebuild answers 200");
  check(await boardMmr(ids.cheater), 1_525, "held players are not published by the rebuild");

  console.log("\n== 4. Resume");
  response = await call("POST", `/sanctions/${sanction.sanctionId}/resume`);
  check(response.status, 200, "200: the reversal completed");
  check(response.body.reversal.status, "completed", "reversal status");
  check(response.body.reversal.attempts, 2, "it took two attempts");
  check(await mmrOf(ids.cheater), 1_475, "MongoDB: cheater 1525 - 25 - 25 (match 1 not reverted twice)");
  check(await mmrOf(ids.rival1), 1_525, "MongoDB: rival1 gets its 25 back");
  check(await mmrOf(ids.rival2), 1_500, "MongoDB: rival2 gets its 25 back");
  check(await boardMmr(ids.cheater), 1_475, "Redis: the leaderboard shows the cheater at 1475");
  check(await boardMmr(ids.rival1), 1_525, "Redis: and rival1 at 1525, in the same instant");
  check(
    await boardMmr(ids.rival2),
    "PLAYER_NOT_RANKED",
    "Redis: rival2 leaves the board (its only match of the season was voided)",
  );
  check(await redis.hexists(`lb:${SEASON}:${MODE}:held`, ids.cheater), 0, "Redis: no hold left");
  response = await call("GET", `/history/players/${ids.rival2}`);
  check(response.body.matches.length, 0, "Cassandra: rival2's history no longer has match 2");
  response = await call("GET", `/profiles/${ids.cheater}`);
  check(
    response.body.recentMatches.map((match) => match.matchId).join(","),
    ids.m3,
    "profile: only the legit match is left",
  );
  check(response.body.sanctions[0]?.inForce, true, "profile: the sanction is in force");

  console.log("\n== 5. Retries, failures before registering, invalid requests, matchmaking");
  response = await call("POST", "/sanctions", sanction);
  check(response.status, 200, "repeating the request answers 200");
  check(await mmrOf(ids.cheater), 1_475, "and reverts nothing again");

  const other = { ...sanction, sanctionId: randomUUID() };
  response = await call("POST", "/sanctions", other, { "x-fail-db": "mongo" });
  check(`${response.status}/${response.body.error}`, "500/INJECTED_FAILURE", "failure before the insert");
  response = await call("GET", `/sanctions/${other.sanctionId}`);
  check(response.status, 404, "so no sanction was registered");

  response = await call("POST", "/sanctions", {
    ...other,
    matchIds: [ids.m1],
    playerId: ids.rival2,
    reportId: null,
  });
  check(
    `${response.status}/${response.body.error}/${response.body.reason}`,
    "422/MATCH_NOT_REVERSIBLE/not_participant",
    "a match the player did not play is refused",
  );

  response = await call("POST", "/matchmaking/queue", { mode: MODE, playerId: ids.cheater });
  check(`${response.status}/${response.body.error}`, "403/PLAYER_SANCTIONED", "the cheater cannot queue");
} finally {
  await mongo.close();
  redis.disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
