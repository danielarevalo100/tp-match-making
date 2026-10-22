#!/usr/bin/env node
// Demo del problema 3: eventos dentro de la partida (log en Cassandra + marcador en vivo en Redis).
//
// Necesita el stack corriendo (mongodb, redis, cassandra con el esquema aplicado y gaming-app).
// Usa el flujo real de los problemas 1 y 2 para tener partidas en vivo (registra jugadores, los
// pone en cola, forma las partidas) y después:
//   1. dispara eventos a todas las partidas a la vez, con duplicados y timestamps desordenados,
//      mientras consulta los marcadores, e informa throughput y latencia
//   2. controla que cada marcador sea la suma de los eventos, y que Cassandra guardó cada evento
//      exactamente una vez
//   3. provoca fallas: antes de escribir el log, y entre el log y el marcador
//
//   node scripts/demo-problem-3.mjs
//
// Se puede cambiar (entorno): APP_URL, MATCHES (100), EVENTS_PER_MATCH (300), CONCURRENCY (64),
// MODE (ranked_1v1), REGION (NA). Deja las partidas en vivo: no se cierran hasta el problema 4.

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3001";
const MATCHES = Number(process.env.MATCHES ?? 100);
const EVENTS_PER_MATCH = Number(process.env.EVENTS_PER_MATCH ?? 300);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);
const MODE = process.env.MODE ?? "ranked_1v1";
const REGION = process.env.REGION ?? "NA";
const DUPLICATE_RATE = 0.05;

let failures = 0;
const ok = (message) => console.log(`  OK   ${message}`);
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL ${message}`);
};
const check = (actual, expected, message) =>
  actual === expected ? ok(`${message} (${actual})`) : fail(`${message}: expected ${expected}, got ${actual}`);

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method,
  });
  const text = await response.text();
  return { body: text ? JSON.parse(text) : null, status: response.status };
}

// Ejecuta `worker` sobre `items` con a lo sumo `limit` en paralelo.
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

const shuffle = (items) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const summary = (label, samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(
    `  ${label}: n=${sorted.length} p50=${percentile(sorted, 0.5).toFixed(1)}ms ` +
      `p95=${percentile(sorted, 0.95).toFixed(1)}ms p99=${percentile(sorted, 0.99).toFixed(1)}ms ` +
      `max=${(sorted.at(-1) ?? 0).toFixed(1)}ms`,
  );
};

// ---------------------------------------------------------------------------
// Preparación: partidas en vivo usando los problemas 1 y 2
// ---------------------------------------------------------------------------

async function createLiveMatches(count) {
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const playerIds = new Array(count * 2);
  await pool([...playerIds.keys()], 16, async (index) => {
    const created = await call("POST", "/players", {
      country: "US",
      email: `p3_${run}_${index}@example.com`,
      password: "a-secure-password",
      username: `p3_${run}_${index}`,
    });
    if (created.status !== 201) throw new Error(`Could not register a player: ${JSON.stringify(created)}`);
    playerIds[index] = created.body.id;
  });
  await pool(playerIds, 32, async (playerId) => {
    const queued = await call("POST", "/matchmaking/queue", { mode: MODE, playerId, region: REGION });
    if (queued.status !== 201) throw new Error(`Could not queue a player: ${JSON.stringify(queued)}`);
  });

  const matches = [];
  while (matches.length < count) {
    const formed = await call("POST", "/matchmaking/matches/form", { mode: MODE, region: REGION });
    if (formed.status !== 201 || formed.body.status !== "formed") {
      throw new Error(`Could not form a match: ${JSON.stringify(formed)}`);
    }
    matches.push({
      matchId: formed.body.matchId,
      players: formed.body.players.map((player) => player.playerId),
    });
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Generación de eventos y el marcador que tienen que sumar
// ---------------------------------------------------------------------------

function generateEvents(match, count, startMs) {
  const events = [];
  for (let i = 0; i < count; i++) {
    const playerId = match.players[Math.floor(Math.random() * match.players.length)];
    const roll = Math.random();
    const base = {
      eventId: randomUUID(),
      playerId,
      // Varios eventos comparten el mismo milisegundo a propósito.
      tsMs: startMs + Math.floor(i / 3) * 7,
    };
    if (roll < 0.6) {
      const others = match.players.filter((id) => id !== playerId);
      events.push({ ...base, targetPlayerId: others[Math.floor(Math.random() * others.length)], type: "kill" });
    } else if (roll < 0.85) {
      events.push({ ...base, points: 1 + Math.floor(Math.random() * 5), type: "objective" });
    } else {
      events.push({ ...base, type: roll < 0.93 ? "disconnect" : "reconnect" });
    }
  }
  return events;
}

function expectedScoreboard(match, events) {
  const players = new Map(
    match.players.map((id) => [id, { connected: true, connectionTs: 0, deaths: 0, kills: 0, objectives: 0, score: 0 }]),
  );
  for (const event of events) {
    const actor = players.get(event.playerId);
    if (event.type === "kill") {
      actor.kills += 1;
      actor.score += 1;
      players.get(event.targetPlayerId).deaths += 1;
    } else if (event.type === "objective") {
      actor.objectives += 1;
      actor.score += event.points ?? 1;
    } else if (event.tsMs > actor.connectionTs || (event.tsMs === actor.connectionTs && event.type === "disconnect")) {
      actor.connectionTs = event.tsMs;
      actor.connected = event.type === "reconnect";
    }
  }
  return players;
}

function diffScoreboard(expected, actual) {
  const problems = [];
  for (const row of actual.players) {
    const want = expected.get(row.playerId);
    for (const field of ["kills", "deaths", "objectives", "score", "connected"]) {
      if (row[field] !== want[field]) problems.push(`${row.playerId.slice(0, 8)}.${field}: want ${want[field]}, got ${row[field]}`);
    }
  }
  return problems;
}

async function countStoredEvents(matchId) {
  let count = 0;
  let pageState;
  do {
    const page = await call("GET", `/matches/${matchId}/events?limit=1000${pageState ? `&pageState=${pageState}` : ""}`);
    if (page.status !== 200) throw new Error(`Could not list events: ${JSON.stringify(page)}`);
    count += page.body.events.length;
    pageState = page.body.nextPageState ?? undefined;
  } while (pageState);
  return count;
}

// ---------------------------------------------------------------------------

console.log(`== Setup: ${MATCHES} live matches through problems 1 and 2 (${MODE}/${REGION})`);
let started = performance.now();
const matches = await createLiveMatches(MATCHES);
console.log(`  ${matches.length} matches formed in ${((performance.now() - started) / 1000).toFixed(1)}s`);

console.log(`\n== 1. Load: ${MATCHES} simultaneous matches, ${EVENTS_PER_MATCH} events each, ${DUPLICATE_RATE * 100}% re-sent`);
const startMs = Date.now() - 10 * 60_000;
const uniqueEvents = new Map(); // matchId -> events
const requests = [];
for (const match of matches) {
  const events = generateEvents(match, EVENTS_PER_MATCH, startMs);
  uniqueEvents.set(match.matchId, events);
  for (const event of events) {
    requests.push({ event, matchId: match.matchId });
    if (Math.random() < DUPLICATE_RATE) requests.push({ event, matchId: match.matchId });
  }
}
// Eventos de todas las partidas intercalados y sin orden de timestamp.
shuffle(requests);

const postLatencies = [];
const readLatencies = [];
const statuses = new Map();
let polling = true;
const poller = (async () => {
  while (polling) {
    const match = matches[Math.floor(Math.random() * matches.length)];
    const t0 = performance.now();
    const board = await call("GET", `/matches/${match.matchId}/scoreboard`);
    readLatencies.push(performance.now() - t0);
    if (board.status !== 200) fail(`scoreboard read answered ${board.status}`);
  }
})();

started = performance.now();
await pool(requests, CONCURRENCY, async ({ event, matchId }) => {
  const t0 = performance.now();
  const response = await call("POST", `/matches/${matchId}/events`, event);
  postLatencies.push(performance.now() - t0);
  const key = `${response.status}${response.body?.status ? `/${response.body.status}` : ""}`;
  statuses.set(key, (statuses.get(key) ?? 0) + 1);
});
const seconds = (performance.now() - started) / 1000;
polling = false;
await poller;

console.log(`  ${requests.length} requests in ${seconds.toFixed(1)}s = ${(requests.length / seconds).toFixed(0)} req/s`);
console.log(`  answers: ${[...statuses].map(([key, n]) => `${key}=${n}`).join("  ")}`);
summary("POST event      ", postLatencies);
summary("GET scoreboard  ", readLatencies);

const sent = [...uniqueEvents.values()].reduce((total, events) => total + events.length, 0);
check(statuses.get("201/recorded") ?? 0, sent, "every distinct event was recorded exactly once");
check(Object.keys(Object.fromEntries(statuses)).filter((key) => !key.startsWith("20")).length, 0, "no request failed");

console.log("\n== 2. Consistency: scoreboards and Cassandra against what was sent");
let wrongBoards = 0;
let wrongLogs = 0;
await pool(matches, 16, async (match) => {
  const events = uniqueEvents.get(match.matchId);
  const board = await call("GET", `/matches/${match.matchId}/scoreboard`);
  const problems = diffScoreboard(expectedScoreboard(match, events), board.body);
  if (board.body.eventCount !== events.length) problems.push(`eventCount: want ${events.length}, got ${board.body.eventCount}`);
  if (problems.length > 0) {
    wrongBoards += 1;
    console.log(`    ${match.matchId}: ${problems.slice(0, 3).join("; ")}`);
  }
  const stored = await countStoredEvents(match.matchId);
  if (stored !== events.length) {
    wrongLogs += 1;
    console.log(`    ${match.matchId}: Cassandra has ${stored} events, expected ${events.length}`);
  }
});
check(wrongBoards, 0, `scoreboards that differ from the events (of ${matches.length})`);
check(wrongLogs, 0, `matches whose Cassandra log differs from the events sent (of ${matches.length})`);

console.log("\n== 3. Failures");
const target = matches[0];
const [first, second] = target.players;
const event = () => ({ eventId: randomUUID(), playerId: first, targetPlayerId: second, tsMs: Date.now(), type: "kill" });
const snapshot = async () => {
  const board = (await call("GET", `/matches/${target.matchId}/scoreboard`)).body;
  return { events: board.eventCount, kills: board.players.find((row) => row.playerId === first).kills, log: await countStoredEvents(target.matchId) };
};

const before = await snapshot();
console.log("  3a. Failure before the log write (x-fail-db: cassandra)");
const lost = event();
let response = await call("POST", `/matches/${target.matchId}/events`, lost, { "x-fail-db": "cassandra" });
check(response.status, 500, "the request fails");
let after = await snapshot();
check(`${after.log}/${after.events}`, `${before.log}/${before.events}`, "nothing was written to Cassandra nor to the scoreboard");

console.log("  3b. Failure between the log and the scoreboard (x-fail-db: redis)");
response = await call("POST", `/matches/${target.matchId}/events`, lost, { "x-fail-db": "redis" });
check(response.status, 500, "the request fails");
after = await snapshot();
check(after.log, before.log + 1, "the event is already safe in Cassandra");
check(after.events, before.events, "the scoreboard does not have it yet");
response = await call("POST", `/matches/${target.matchId}/events`, lost);
check(`${response.status}/${response.body.status}`, "201/recorded", "retrying the same eventId applies it");
after = await snapshot();
check(`${after.log}/${after.events}/${after.kills}`, `${before.log + 1}/${before.events + 1}/${before.kills + 1}`, "log and scoreboard agree, the kill counted once");
response = await call("POST", `/matches/${target.matchId}/events`, lost);
check(`${response.status}/${response.body.status}`, "200/duplicate", "a further retry changes nothing");

console.log("  3c. Same failure, repaired with reconcile instead of a retry");
const orphan = event();
await call("POST", `/matches/${target.matchId}/events`, orphan, { "x-fail-db": "redis" });
response = await call("POST", `/matches/${target.matchId}/scoreboard/reconcile`);
check(`${response.body.repaired}`, "1", `reconcile repaired the missing event (read ${response.body.read})`);
response = await call("POST", `/matches/${target.matchId}/scoreboard/reconcile`);
check(`${response.body.repaired}`, "0", "running reconcile again repairs nothing");
after = await snapshot();
check(after.log, after.events, "log and scoreboard have the same number of events");

console.log("\n== 4. Rejections");
response = await call("POST", `/matches/${randomUUID()}/events`, event());
check(response.status, 404, "an event for a match that is not live");
response = await call("POST", `/matches/${target.matchId}/events`, { ...event(), playerId: randomUUID() });
check(response.status, 422, "an event from a player who is not in the match");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
