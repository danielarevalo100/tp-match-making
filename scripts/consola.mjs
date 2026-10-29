#!/usr/bin/env node
// Consola interactiva para mostrar el trabajo: pide datos, los manda a la API y después lee
// directamente cada motor (MongoDB, Redis, Cassandra, Neo4j) para mostrar dónde quedó cada dato.
//
// Needs the Compose stack running with the schema applied and the gamingApp dependencies
// installed (`pnpm install` in gamingApp): it borrows the app's drivers to read the engines.
//
//   consola.cmd                    (desde CMD, en la raíz del repo)
//   node scripts/consola.mjs
//
// Overrides (environment): APP_URL, MONGODB_URI, MONGODB_DB_NAME, REDIS_URL, CASSANDRA_HOST,
// CASSANDRA_PORT, NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { inspect } from "node:util";

const require = createRequire(new URL("../gamingApp/package.json", import.meta.url));
const { MongoClient } = require("mongodb");
const { Redis } = require("ioredis");
const cassandra = require("cassandra-driver");
const neo4j = require("neo4j-driver");

function readEnvFile() {
  for (const name of [".env", ".env.example"]) {
    try {
      const text = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
      return Object.fromEntries(
        text
          .split(/\r?\n/)
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
const env = (name, fallback) => process.env[name] ?? fallback;
const APP_URL = env("APP_URL", `http://127.0.0.1:${dotenv.GAMING_APP_PORT ?? 3001}`);
const MONGODB_URI = env(
  "MONGODB_URI",
  `mongodb://${encodeURIComponent(dotenv.MONGO_ROOT_USERNAME ?? "gaming_admin")}:` +
    `${encodeURIComponent(dotenv.MONGO_ROOT_PASSWORD ?? "change_me_local_only")}` +
    `@127.0.0.1:${dotenv.MONGO_PORT ?? 27017}/?authSource=admin`,
);
const MONGODB_DB_NAME = env("MONGODB_DB_NAME", "gaming");
const REDIS_URL = env("REDIS_URL", `redis://127.0.0.1:${dotenv.REDIS_PORT ?? 6379}`);
const CASSANDRA_HOST = env("CASSANDRA_HOST", "127.0.0.1");
const CASSANDRA_PORT = Number(env("CASSANDRA_PORT", dotenv.CASSANDRA_PORT ?? 9042));
const NEO4J_URI = env("NEO4J_URI", `bolt://127.0.0.1:${dotenv.NEO4J_BOLT_PORT ?? 7687}`);
const NEO4J_USERNAME = env("NEO4J_USERNAME", "neo4j");
const NEO4J_PASSWORD = env(
  "NEO4J_PASSWORD",
  dotenv.NEO4J_PASSWORD ?? dotenv.NEO4J_AUTH?.split("/")[1] ?? "change_me_local_only",
);

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------

const color = (code) => (text) => `\x1b[${code}m${text}\x1b[0m`;
const bold = color("1");
const dim = color("2");
const red = color("31");
const green = color("32");
const yellow = color("33");
const cyan = color("36");
const magenta = color("35");
const blue = color("34");

const engines = {
  API: yellow,
  Cassandra: cyan,
  MongoDB: green,
  Neo4j: magenta,
  Redis: red,
};

const line = (char = "-") => console.log(dim(char.repeat(78)));
const title = (text) => {
  console.log();
  line("=");
  console.log(bold(`  ${text}`));
  line("=");
};
const step = (text) => console.log(`\n${bold(blue(">>"))} ${text}`);
const info = (text) => console.log(dim(`   ${text}`));
const okMsg = (text) => console.log(green(`   OK  ${text}`));
const errMsg = (text) => console.log(red(`   ERROR  ${text}`));

// One block per engine: what was read and from where.
function show(engine, where, value) {
  const paint = engines[engine] ?? ((text) => text);
  console.log(`\n   ${paint(bold(`[${engine}]`))} ${dim(where)}`);
  const body =
    value === undefined || value === null
      ? dim("(no existe)")
      : inspect(value, { breakLength: 70, colors: true, compact: 3, depth: 5 });
  console.log(body.replace(/^/gm, "     "));
}

const short = (id) => (id ? String(id).slice(0, 8) : "-");

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

const rl = createInterface({ input: stdin, output: stdout });

async function ask(question, fallback) {
  const suffix = fallback === undefined ? "" : dim(` [${fallback}]`);
  const answer = (await rl.question(`   ${question}${suffix}: `)).trim();
  return answer || (fallback === undefined ? "" : String(fallback));
}

async function confirm(question, fallback = false) {
  const answer = (await ask(`${question} (s/n)`, fallback ? "s" : "n")).toLowerCase();
  return answer.startsWith("s") || answer.startsWith("y");
}

async function choose(question, options, render) {
  if (options.length === 0) return null;
  options.forEach((option, index) => console.log(`     ${bold(String(index + 1))}) ${render(option)}`));
  while (true) {
    const answer = Number(await ask(question, 1));
    if (Number.isInteger(answer) && answer >= 1 && answer <= options.length) return options[answer - 1];
    errMsg(`Elegí un número entre 1 y ${options.length}.`);
  }
}

const pause = () => rl.question(dim("\n   Enter para continuar..."));

// ---------------------------------------------------------------------------
// API y motores
// ---------------------------------------------------------------------------

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { body: parsed, status: response.status };
}

// Prints the request and the answer; returns the body only when the API accepted it.
async function api(method, path, body, headers) {
  console.log(`\n   ${yellow(bold("[API]"))} ${method} ${path}`);
  if (body !== undefined) info(JSON.stringify(body));
  const response = await call(method, path, body, headers);
  if (response.body?.error === "INJECTED_FAILURE") {
    const where = response.body.step ?? response.body.engine ?? "?";
    console.log(`   ${yellow(`HTTP ${response.status}  falla simulada en "${where}" (esperada)`)}`);
    return null;
  }
  const paint = response.status < 300 ? green : red;
  console.log(`   ${paint(`HTTP ${response.status}`)}`);
  if (response.status >= 300) {
    console.log(inspect(response.body, { colors: true, depth: 4 }).replace(/^/gm, "     "));
    return null;
  }
  return response.body;
}

const db = { cassandra: null, mongo: null, neo4j: null, redis: null };
let mongoDb = null;

async function connectEngines() {
  step("Conectando a los motores...");
  const attempts = {
    API: async () => {
      const ready = await call("GET", "/ready");
      if (ready.status !== 200) throw new Error(`/ready respondió ${ready.status}`);
    },
    Cassandra: async () => {
      const client = new cassandra.Client({
        contactPoints: [`${CASSANDRA_HOST}:${CASSANDRA_PORT}`],
        keyspace: "gaming",
        localDataCenter: "datacenter1",
        socketOptions: { connectTimeout: 4_000 },
      });
      await client.connect();
      db.cassandra = client;
    },
    MongoDB: async () => {
      const client = new MongoClient(MONGODB_URI, { appName: "consola", serverSelectionTimeoutMS: 4_000 });
      await client.connect();
      db.mongo = client;
      mongoDb = client.db(MONGODB_DB_NAME);
    },
    Neo4j: async () => {
      const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD), {
        connectionTimeout: 4_000,
        disableLosslessIntegers: true,
      });
      await driver.verifyConnectivity();
      db.neo4j = driver;
    },
    Redis: async () => {
      const client = new Redis(REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      client.on("error", () => {});
      await client.connect();
      db.redis = client;
    },
  };
  let apiUp = true;
  for (const [name, attempt] of Object.entries(attempts)) {
    try {
      await attempt();
      console.log(`   ${engines[name](name.padEnd(10))} ${green("conectado")}`);
    } catch (error) {
      if (name === "API") apiUp = false;
      const reason = String(error.message).split("\n")[0].slice(0, 90);
      console.log(`   ${engines[name](name.padEnd(10))} ${red(`no disponible (${reason})`)}`);
    }
  }
  if (!apiUp) {
    errMsg(`La API no responde en ${APP_URL}. Levantá el stack con "docker compose up -d".`);
  }
}

// Reads any Redis key, whatever its type.
async function redisRead(key) {
  if (!db.redis) return "(Redis no disponible)";
  const type = await db.redis.type(key);
  switch (type) {
    case "none":
      return null;
    case "string":
      return db.redis.get(key);
    case "hash":
      return db.redis.hgetall(key);
    case "set":
      return db.redis.smembers(key);
    case "list":
      return db.redis.lrange(key, 0, 20);
    case "zset": {
      const flat = await db.redis.zrevrange(key, 0, 9, "WITHSCORES");
      const entries = [];
      for (let i = 0; i < flat.length; i += 2) entries.push({ member: flat[i], score: Number(flat[i + 1]) });
      return { primeros10: entries, total: await db.redis.zcard(key) };
    }
    default:
      return `(tipo ${type})`;
  }
}

function cassandraValue(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && typeof value.toString === "function") return value.toString();
  return value;
}

async function cassandraRows(query, params) {
  if (!db.cassandra) return "(Cassandra no disponible)";
  const result = await db.cassandra.execute(query, params, { prepare: true });
  return result.rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cassandraValue(value)])),
  );
}

async function neo4jRows(query, params) {
  if (!db.neo4j) return "(Neo4j no disponible)";
  const { records } = await db.neo4j.executeQuery(query, params, { database: "neo4j" });
  return records.map((record) => record.toObject());
}

const mongo = (collection) => mongoDb?.collection(collection);

async function mongoFind(collection, filter, projection) {
  if (!mongoDb) return "(MongoDB no disponible)";
  return mongo(collection).findOne(filter, { projection });
}

async function activeSeason() {
  if (!mongoDb) return null;
  return mongo("seasons").findOne({ status: "active" });
}

// ---------------------------------------------------------------------------
// Estado de la sesión
// ---------------------------------------------------------------------------

const session = { matches: [], players: [] };

const renderPlayer = (player) =>
  `${bold(player.username)} ${dim(`${player.country}/${player.region} id=${short(player.id)}`)}`;
const renderMatch = (match) =>
  `${bold(short(match.matchId))} ${match.mode}/${match.region} ` +
  `${dim(`${match.players.length} jugadores, ${match.closed ? "cerrada" : "en curso"}`)}`;

// Players registered in an earlier run only live in MongoDB; they join the session when looked up by name.
async function loadPlayer(username) {
  const known = session.players.find((player) => player.username === username);
  if (known) return known;
  if (!mongoDb) {
    errMsg("MongoDB no está disponible para buscar el jugador.");
    return null;
  }
  const doc = await mongo("players").findOne({ username }, { projection: { country: 1, region: 1, username: 1 } });
  if (!doc) {
    errMsg(`No existe el jugador "${username}" en MongoDB. Registralo con la opción 1.`);
    return null;
  }
  const player = { country: doc.country, id: doc._id, region: doc.region, username: doc.username };
  session.players.push(player);
  okMsg(`Jugador ${player.username} encontrado en MongoDB (id ${player.id}).`);
  return player;
}

async function pickPlayer(question = "Jugador") {
  session.players.forEach((player, index) => console.log(`     ${bold(String(index + 1))}) ${renderPlayer(player)}`));
  const hint = session.players.length > 0 ? "número de la lista o nombre de usuario" : "nombre de usuario";
  while (true) {
    const answer = (await ask(`${question} (${hint})`, session.players.length > 0 ? 1 : undefined)).toLowerCase();
    if (!answer) {
      errMsg("Escribí un nombre de usuario.");
      continue;
    }
    if (/^\d+$/.test(answer)) {
      const player = session.players[Number(answer) - 1];
      if (player) return player;
      if (session.players.length > 0) {
        errMsg(`Elegí un número entre 1 y ${session.players.length}, o escribí un nombre de usuario.`);
        continue;
      }
    }
    return loadPlayer(answer);
  }
}

async function pickMatch(onlyLive) {
  const matches = session.matches.filter((match) => !onlyLive || !match.closed);
  if (matches.length === 0) {
    errMsg(onlyLive ? "No hay partidas en curso en esta sesión (opción 3)." : "No hay partidas en esta sesión.");
    return null;
  }
  return choose("Partida", matches, renderMatch);
}

const playerName = (playerId) =>
  session.players.find((player) => player.id === playerId)?.username ?? short(playerId);

// ---------------------------------------------------------------------------
// 1. Registrar jugador (API -> MongoDB)
// ---------------------------------------------------------------------------

async function registerPlayer(input) {
  title("Registrar jugador  ->  MongoDB");
  const suffix = randomUUID().slice(0, 4);
  const data = input ?? {
    country: (await ask("País (código ISO de 2 letras, ej. AR, US, BR, ES)", "AR")).toUpperCase(),
    username: (await ask("Nombre de usuario (minúsculas, números, _ y -)", `jugador_${suffix}`)).toLowerCase(),
  };
  const body = {
    country: data.country,
    email: `${data.username}@example.com`,
    password: "demo-password-123",
    username: data.username,
  };

  step("La API valida y guarda el documento del jugador en MongoDB (dueño del dato).");
  const player = await api("POST", "/players", body);
  if (!player) return null;
  session.players.push(player);
  okMsg(`Jugador ${player.username} creado con id ${player.id}`);

  step("Leemos el documento directamente desde MongoDB:");
  show(
    "MongoDB",
    `db.players.findOne({ _id: "${player.id}" })`,
    await mongoFind("players", { _id: player.id }, { passwordHash: 0 }),
  );
  info("La región se deriva del país usando la colección regions. La contraseña se guarda hasheada.");
  info("Este _id es el identificador que comparten los cuatro motores.");
  return player;
}

// ---------------------------------------------------------------------------
// 2. Entrar a la cola (lee MongoDB, escribe Redis) — problema 1
// ---------------------------------------------------------------------------

async function enqueuePlayer(player, mode) {
  title("Entrar a la cola  ->  lee MongoDB, escribe Redis  (problema 1)");
  player ??= await pickPlayer();
  if (!player) return null;
  mode ??= await ask("Modo de juego", "ranked_1v1");

  step("MongoDB es la fuente para validar: cuenta activa, sin sanción, MMR del modo.");
  show(
    "MongoDB",
    `db.players.findOne({ _id: "${short(player.id)}…" }, { accountStatus, region, ratings })`,
    await mongoFind("players", { _id: player.id }, { _id: 0, accountStatus: 1, ratings: 1, region: 1 }),
  );

  step("Un script Lua en Redis verifica y escribe el ticket + las dos colas en un solo paso.");
  const ticket = await api("POST", "/matchmaking/queue", { mode, playerId: player.id });
  if (!ticket) return null;

  const region = ticket.region ?? player.region;
  show("Redis", `HGETALL mm:ticket:${short(player.id)}…`, await redisRead(`mm:ticket:${player.id}`));
  if (db.redis) {
    show("Redis", `ZSCORE mm:q:${mode}:${region}:rating  (cola ordenada por MMR)`, {
      mmr: await db.redis.zscore(`mm:q:${mode}:${region}:rating`, player.id),
    });
    show("Redis", `ZSCORE mm:q:${mode}:${region}:wait  (cola ordenada por antigüedad)`, {
      enqueuedAt: await db.redis.zscore(`mm:q:${mode}:${region}:wait`, player.id),
      jugadoresEnCola: await db.redis.zcard(`mm:q:${mode}:${region}:wait`),
    });
  }
  info("El MMR se copia al ticket: mientras está en cola no puede cambiar.");
  return ticket;
}

// ---------------------------------------------------------------------------
// 3. Formar partida (saga Redis -> MongoDB -> Redis) — problema 2
// ---------------------------------------------------------------------------

async function formMatch(mode, region) {
  title("Formar partida  ->  Redis reserva, MongoDB crea, Redis confirma  (problema 2)");
  mode ??= await ask("Modo de juego", "ranked_1v1");
  region ??= (await ask("Región", session.players.at(-1)?.region ?? "LATAM")).toUpperCase();

  if (db.redis) {
    show("Redis", `ZCARD mm:q:${mode}:${region}:wait  (antes)`, {
      jugadoresEnCola: await db.redis.zcard(`mm:q:${mode}:${region}:wait`),
    });
  }

  const result = await api("POST", "/matchmaking/matches/form", { mode, region });
  if (!result) return null;
  if (result.status !== "formed") {
    errMsg(`No se formó partida: ${result.status} (en cola ${result.queued ?? "?"}, mínimo ${result.required ?? "?"}).`);
    info("Poné más jugadores de esa región en la cola con la opción 2.");
    return null;
  }

  const match = {
    closed: false,
    matchId: result.matchId,
    mode,
    players: result.players.map((ticket) => ticket.playerId),
    region,
  };
  session.matches.push(match);
  okMsg(`Partida ${match.matchId} formada con ${match.players.map(playerName).join(", ")}`);

  step("La misma partida ahora existe en dos motores, con el mismo matchId:");
  show("MongoDB", `db.matches.findOne({ _id: "${short(match.matchId)}…" })  (registro durable)`,
    await mongoFind("matches", { _id: match.matchId }));
  show("Redis", `HGETALL match:${short(match.matchId)}…  (partida viva)`, await redisRead(`match:${match.matchId}`));
  if (db.redis) {
    const pointers = {};
    for (const playerId of match.players) {
      pointers[playerName(playerId)] = await db.redis.get(`player:${playerId}:active_match`);
    }
    show("Redis", "GET player:<id>:active_match  (impide reencolarse)", pointers);
    show("Redis", `ZCARD mm:q:${mode}:${region}:wait  (después)`, {
      jugadoresEnCola: await db.redis.zcard(`mm:q:${mode}:${region}:wait`),
    });
  }
  return match;
}

// ---------------------------------------------------------------------------
// 4. Evento en partida (Cassandra + Redis a la vez) — problema 3
// ---------------------------------------------------------------------------

async function recordEvent(match, event, failBetween = false) {
  title("Evento de partida  ->  Cassandra (log) + Redis (marcador)  (problema 3)");
  match ??= await pickMatch(true);
  if (!match) return null;

  if (!event) {
    const type = await choose("Tipo de evento", ["kill", "objective", "disconnect", "reconnect"], (t) => t);
    const actor = await choose("¿Qué jugador?", match.players, playerName);
    event = { eventId: randomUUID(), playerId: actor, tsMs: Date.now(), type };
    if (type === "kill") {
      const others = match.players.filter((id) => id !== actor);
      event.targetPlayerId = others.length === 1 ? others[0] : await choose("¿A quién?", others, playerName);
    }
    if (type === "objective") event.points = Number(await ask("Puntos (1-1000)", 3));
    failBetween = await confirm("¿Simular que Redis falla después de escribir en Cassandra?", false);
  }

  step("Orden de escritura: primero Cassandra (la verdad), después el marcador en Redis.");
  const headers = failBetween ? { "x-fail-at": "matchEvents.applyScoreboard" } : {};
  if (failBetween) info("Se envía el header x-fail-at: matchEvents.applyScoreboard (inyección de fallas).");
  const result = await api("POST", `/matches/${match.matchId}/events`, event, headers);

  step(`El mismo eventId ${short(event.eventId)}… leído en los dos motores:`);
  await showEventInEngines(match, event);

  if (failBetween) {
    info("El evento quedó a salvo en Cassandra pero el marcador de Redis no lo tiene.");
    if (await confirm("¿Reparar el marcador con reconcile (relee el log de Cassandra)?", true)) {
      const repair = await api("POST", `/matches/${match.matchId}/scoreboard/reconcile`);
      if (repair) info(`Eventos leídos del log: ${repair.read}, reparados en el marcador: ${repair.repaired}`);
      step("Después de reconciliar:");
      await showEventInEngines(match, event);
      okMsg("Log y marcador vuelven a coincidir. El evento se contó una sola vez.");
    }
  } else if (result) {
    okMsg(`Resultado: ${result.status}. Reenviar el mismo eventId no lo duplica (idempotencia por Lua).`);
  }
  return event;
}

async function showEventInEngines(match, event) {
  show(
    "Cassandra",
    `SELECT * FROM events_by_match WHERE match_id = ${short(match.matchId)}… AND ts = … AND event_id = ${short(event.eventId)}…`,
    (await cassandraRows(
      "SELECT ts, event_id, event_type, player_id, target_player_id, points FROM events_by_match " +
        "WHERE match_id = ? AND ts = ? AND event_id = ?",
      [match.matchId, new Date(event.tsMs), event.eventId],
    ))[0] ?? null,
  );
  if (db.redis) {
    show("Redis", `SISMEMBER match:${short(match.matchId)}…:applied ${short(event.eventId)}…`, {
      aplicadoAlMarcador: (await db.redis.sismember(`match:${match.matchId}:applied`, event.eventId)) === 1,
    });
  }
  const board = await call("GET", `/matches/${match.matchId}/scoreboard`);
  if (board.status === 200) {
    show(
      "Redis",
      `marcador vivo (GET /matches/${short(match.matchId)}…/scoreboard), eventos aplicados: ${board.body.eventCount}`,
      board.body.players.map((row) => ({
        jugador: playerName(row.playerId),
        kills: row.kills,
        muertes: row.deaths,
        objetivos: row.objectives,
        puntaje: row.score,
        conectado: row.connected,
      })),
    );
  }
  const total = await cassandraRows("SELECT COUNT(*) AS eventos FROM events_by_match WHERE match_id = ?", [
    match.matchId,
  ]);
  show("Cassandra", `SELECT COUNT(*) FROM events_by_match WHERE match_id = ${short(match.matchId)}…`, total[0] ?? total);
}

// ---------------------------------------------------------------------------
// 5. Cerrar partida (Redis, MongoDB, Cassandra) — problemas 4 y 5
// ---------------------------------------------------------------------------

async function finishMatch(match, results) {
  title("Cerrar partida  ->  Redis, MongoDB, Cassandra y leaderboard  (problemas 4 y 5)");
  match ??= await pickMatch(true);
  if (!match) return null;

  if (!results) {
    results = [];
    for (const [index, playerId] of match.players.entries()) {
      const result = await ask(`Resultado de ${playerName(playerId)} (win/loss/draw)`, index === 0 ? "win" : "loss");
      results.push({ playerId, result });
    }
  }

  const before = {};
  if (mongoDb) {
    for (const playerId of match.players) {
      const doc = await mongo("players").findOne({ _id: playerId }, { projection: { ratings: 1 } });
      before[playerId] = doc?.ratings?.[match.mode]?.mmr ?? null;
    }
  }

  const tsMs = Date.now();
  const result = await api("POST", `/matches/${match.matchId}/finish`, {
    closureId: randomUUID(),
    eventId: randomUUID(),
    reason: "normal",
    results,
    tsMs,
  });
  if (!result) return null;
  match.closed = true;
  okMsg("Partida cerrada.");

  step("1) Cassandra: el evento match_finished es el punto de no retorno.");
  const events = await cassandraRows(
    "SELECT ts, event_id, event_type FROM events_by_match WHERE match_id = ? AND ts >= ?",
    [match.matchId, new Date(tsMs)],
  );
  show(
    "Cassandra",
    `SELECT … FROM events_by_match WHERE match_id = ${short(match.matchId)}… (event_type = match_finished)`,
    Array.isArray(events) ? events.filter((row) => row.event_type === "match_finished") : events,
  );

  step("2) Redis: se libera a los jugadores y se borra el estado vivo.");
  if (db.redis) {
    const live = {};
    for (const key of [`match:${match.matchId}`, `match:${match.matchId}:scoreboard`]) {
      live[key.replace(match.matchId, `${short(match.matchId)}…`)] = (await db.redis.exists(key)) ? "existe" : "borrada";
    }
    for (const playerId of match.players) {
      live[`active_match de ${playerName(playerId)}`] = (await db.redis.get(`player:${playerId}:active_match`)) ?? "libre";
    }
    show("Redis", "EXISTS / GET", live);
  }

  step("3) MongoDB: estado de la partida y rating aplicado (resultado reconstruido desde Cassandra).");
  show(
    "MongoDB",
    `db.matches.findOne({ _id: "${short(match.matchId)}…" }, { status, scoringStatus, leaderboard, finalScoreboard })`,
    await mongoFind(
      "matches",
      { _id: match.matchId },
      { _id: 0, finalScoreboard: 1, "leaderboard.status": 1, scoringStatus: 1, status: 1 },
    ),
  );
  if (mongoDb) {
    const ratings = [];
    for (const playerId of match.players) {
      const doc = await mongo("players").findOne({ _id: playerId }, { projection: { ratings: 1 } });
      ratings.push({
        jugador: playerName(playerId),
        resultado: results.find((entry) => entry.playerId === playerId)?.result,
        mmrAntes: before[playerId],
        mmrDespues: doc?.ratings?.[match.mode]?.mmr ?? null,
      });
    }
    show("MongoDB", `db.players … ratings.${match.mode}.mmr`, ratings);
  }

  step("4) Redis: el nuevo MMR se publica en el leaderboard de la temporada (último paso).");
  const season = await activeSeason();
  if (season && db.redis) {
    const key = `lb:${season._id}:${match.mode}:global`;
    const board = [];
    for (const playerId of match.players) {
      const rank = await db.redis.zrevrank(key, playerId);
      board.push({
        jugador: playerName(playerId),
        mmrEnRedis: await db.redis.zscore(key, playerId),
        posicion: rank === null ? null : rank + 1,
      });
    }
    show("Redis", `ZSCORE / ZREVRANK ${key}`, board);
  } else {
    info("No hay temporada activa o Redis no está disponible: la partida no puntúa en un leaderboard.");
  }
  return result;
}

// ---------------------------------------------------------------------------
// 6. Leaderboard (Redis + MongoDB) — problema 5
// ---------------------------------------------------------------------------

async function showLeaderboard() {
  title("Leaderboard  ->  Redis (posición) + MongoDB (nombres)  (problema 5)");
  const season = await activeSeason();
  const seasonId = await ask("Temporada", season?._id ?? "2026-S2");
  const mode = await ask("Modo", "ranked_1v1");
  const region = (await ask("Región (vacío = global)", "")).toUpperCase();

  const top = await api("GET", `/leaderboards/${mode}/${seasonId}${region ? `?region=${region}` : ""}`);
  if (!top) return;
  printRanking(top.entries ?? []);
  info(`Total en el tablero: ${top.totalPlayers ?? "?"}`);
  info("La posición la calcula Redis (ZREVRANK, O(log N)); nombres y país vienen de MongoDB por id.");

  if (session.players.length > 0 && (await confirm("¿Ver la posición de un jugador con sus vecinos?", false))) {
    const player = await pickPlayer();
    const window = await api(
      "GET",
      `/leaderboards/${mode}/${seasonId}/players/${player.id}${region ? `?region=${region}` : ""}`,
    );
    if (window) {
      printRanking([...window.above, window.player, ...window.below], window.player.playerId);
      info("Posición y vecinos salen de un solo script Lua: describen el mismo instante.");
    }
  }
}

function printRanking(entries, highlightId) {
  console.log();
  console.log(bold(`     ${"#".padEnd(7)}${"Jugador".padEnd(28)}${"País".padEnd(6)}${"Región".padEnd(8)}MMR`));
  for (const entry of entries) {
    const row =
      `     ${String(entry.position).padEnd(7)}${String(entry.username ?? short(entry.playerId)).padEnd(28)}` +
      `${String(entry.country ?? "").padEnd(6)}${String(entry.region ?? "").padEnd(8)}${entry.mmr}`;
    console.log(entry.playerId === highlightId ? bold(green(`${row}   <--`)) : row);
  }
}

// ---------------------------------------------------------------------------
// 7. Proyecciones: un hecho de MongoDB copiado a Cassandra y Neo4j — problemas 6 y 7
// ---------------------------------------------------------------------------

async function projectClosedMatches(player) {
  title("Proyecciones  ->  MongoDB a Cassandra (historial) y a Neo4j (grafo)  (problemas 6 y 7)");
  player ??= await pickPlayer("¿De qué jugador mostramos el resultado?");
  if (!player) return;

  step("Proyección de historial: lee partidas cerradas en MongoDB y escribe una fila por jugador en Cassandra.");
  const history = await api("POST", "/history/projection", {});
  if (history) show("API", "resultado", history);

  step("Proyección del grafo: las mismas partidas pasan a Neo4j como (Player)-[:PLAYED]->(Match).");
  const graph = await api("POST", "/fraud/projection", {});
  if (graph) show("API", "resultado", graph);

  step(`El mismo resultado de ${player.username}, ahora en tres motores:`);
  const closed = session.matches.filter((match) => match.closed && match.players.includes(player.id));
  for (const match of closed.slice(-3)) {
    const doc = await mongoFind("matches", { _id: match.matchId });
    show(
      "MongoDB",
      `db.matches.findOne({ _id: "${short(match.matchId)}…" })  (dueño del dato)`,
      typeof doc === "object" && doc
        ? { estado: doc.status, modo: doc.mode, resultados: doc.closure?.results ?? doc.results }
        : doc,
    );
  }
  show(
    "Cassandra",
    `SELECT … FROM match_history_by_player WHERE player_id = ${short(player.id)}… LIMIT 5`,
    await cassandraRows(
      "SELECT ended_at, match_id, mode, result, kills, deaths, score, mmr_before, mmr_after " +
        "FROM match_history_by_player WHERE player_id = ? LIMIT 5",
      [player.id],
    ),
  );
  show(
    "Neo4j",
    "MATCH (p:Player {id:$id})-[r:PLAYED]->(m:Match)<-[r2:PLAYED]-(rival:Player)",
    await neo4jRows(
      "MATCH (p:Player {id: $id})-[r:PLAYED]->(m:Match)<-[r2:PLAYED]-(rival:Player) " +
        "RETURN m.id AS partida, r.result AS resultado, rival.id AS rival, r2.result AS resultadoRival " +
        "ORDER BY m.endedAtMs DESC LIMIT 5",
      { id: player.id },
    ).then((rows) =>
      Array.isArray(rows)
        ? rows.map((row) => ({ ...row, partida: short(row.partida), rival: playerName(row.rival) }))
        : rows,
    ),
  );
  info("Cada motor responde otra pregunta: Cassandra 'últimas N del jugador', Neo4j 'con quién jugó'.");
  info("Las proyecciones son idempotentes: correrlas de nuevo no duplica filas ni nodos.");
}

// ---------------------------------------------------------------------------
// 8. Perfil completo (cuatro motores en paralelo) — problema 8
// ---------------------------------------------------------------------------

async function showProfile(player) {
  title("Perfil completo  ->  MongoDB + Redis + Cassandra en una consulta  (problema 8)");
  player ??= await pickPlayer();
  if (!player) return;
  const profile = await api("GET", `/profiles/${player.id}`);
  if (!profile) return;
  show("MongoDB", "perfil, ratings y sanciones", {
    jugador: profile.player,
    ratings: profile.ratings,
    sanciones: profile.sanctions,
    temporada: profile.seasonId,
  });
  show("Redis", "posiciones en los leaderboards de la temporada", profile.leaderboards);
  show("Cassandra", "últimas partidas (historial)", profile.recentMatches);
  info("Las tres lecturas se hacen en paralelo usando el mismo playerId.");
}

// ---------------------------------------------------------------------------
// 9 y 10. Sanción con reversión de resultados — problema 8
// ---------------------------------------------------------------------------

// Each simulated failure sends the header of the current fault injection (x-fail-at, one step)
// and the one of the per-engine version (x-fail-db): both stop the reversal at the same point.
const sanctionFailures = [
  { label: "Sin falla", headers: {} },
  {
    explain:
      "Falla el borrado del historial en Cassandra en la primera partida: la sanción queda registrada,\n" +
      "   MongoDB ya revirtió esa partida, pero el leaderboard no cambia porque los jugadores están retenidos.",
    headers: { "x-fail-at": "sanctions.deleteHistory", "x-fail-db": "cassandra" },
    label: "Falla a mitad de la reversión          (Cassandra, en la primera partida)",
  },
  {
    explain: "Falla el insert de la sanción en MongoDB: no queda nada registrado ni revertido.",
    headers: { "x-fail-at": "sanctions.insertSanction", "x-fail-db": "mongo" },
    label: "Falla antes de registrar la sanción    (MongoDB)",
  },
];

async function usernames(ids) {
  if (!mongoDb || ids.length === 0) return new Map();
  const docs = await mongo("players")
    .find({ _id: { $in: [...ids] } }, { projection: { username: 1 } })
    .toArray();
  return new Map(docs.map((doc) => [doc._id, doc.username]));
}

// "1,3", "1 3" or "todas" -> the chosen items, in list order.
function pickMany(answer, options) {
  if (/^tod/i.test(answer)) return options;
  const numbers = answer.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > options.length)) {
    return null;
  }
  return options.filter((_, index) => numbers.includes(index + 1));
}

// `automatic`: the guided tour takes the first active administrator, or creates one, without asking.
async function pickAdministrator(automatic = false) {
  const admins = await mongo("administrators")
    .find({ active: true }, { projection: { permissionLevel: 1, username: 1 } })
    .limit(10)
    .toArray();
  if (admins.length > 0) {
    if (automatic) return admins[0];
    return choose("Administrador que sanciona", admins, (admin) =>
      `${bold(admin.username)} ${dim(`${admin.permissionLevel} id=${short(admin._id)}`)}`,
    );
  }
  info("No hay administradores activos en MongoDB (la opción 13 carga tres).");
  if (
    !automatic &&
    !(await confirm("¿Crear un administrador de demostración directamente en MongoDB?", true))
  ) {
    return null;
  }
  const suffix = randomUUID().slice(0, 4);
  const admin = {
    _id: randomUUID(),
    active: true,
    createdAt: new Date(),
    email: `admin_${suffix}@example.com`,
    permissionLevel: "admin",
    username: `admin_${suffix}`,
  };
  await mongo("administrators").insertOne(admin);
  okMsg(`Administrador ${admin.username} creado (no hay endpoint de administradores en la API).`);
  return admin;
}

// `preset` ({ player, matchId, failure }) is how the guided tour sanctions without asking anything.
async function sanctionPlayer(preset) {
  title("Sancionar jugador  ->  MongoDB, Redis, Cassandra y Neo4j  (problema 8)");
  if (!mongoDb) {
    errMsg("Se necesita MongoDB para elegir las partidas.");
    return;
  }
  if (preset) return sanctionPreset(preset);
  info('Con los datos de la opción 13, el tramposo plantado es "seed_player_0".');
  const player = await pickPlayer("Jugador a sancionar");
  if (!player) return;

  step("Partidas cerradas del jugador con el rating ya aplicado (las únicas que se pueden anular):");
  // Matches someone reported come first, then the latest ones.
  const reported = await mongo("reports")
    .find({ matchId: { $ne: null }, reportedPlayerId: player.id }, { projection: { matchId: 1 } })
    .toArray();
  const reportedMatches = new Set(reported.map((report) => report.matchId));
  const reversible = { "players.playerId": player.id, scoringStatus: "applied", status: "closed" };
  const projection = { createdAt: 1, finalScoreboard: 1, mode: 1 };
  const reportedDocs = await mongo("matches")
    .find({ ...reversible, _id: { $in: [...reportedMatches] } }, { projection })
    .toArray();
  const latest = await mongo("matches")
    .find({ ...reversible, _id: { $nin: [...reportedMatches] } }, { projection })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
  const matches = [...reportedDocs, ...latest];
  if (matches.length === 0) {
    errMsg("El jugador no tiene partidas cerradas con scoring aplicado (cerrá una con la opción 5).");
    return;
  }
  const names = await usernames(matches.flatMap((match) => match.finalScoreboard.map((s) => s.playerId)));
  matches.forEach((match, index) => {
    const own = match.finalScoreboard.find((score) => score.playerId === player.id);
    const rivals = match.finalScoreboard
      .filter((score) => score.playerId !== player.id)
      .map((score) => names.get(score.playerId) ?? short(score.playerId));
    const flag = reportedMatches.has(match._id) ? yellow("  (denunciada)") : "";
    console.log(
      `     ${bold(String(index + 1))}) ${bold(short(match._id))} ${match.mode} ` +
        `${dim(match.createdAt.toISOString().slice(0, 16).replace("T", " "))}  ` +
        `${own?.result ?? "?"} (${own?.ratingDelta > 0 ? "+" : ""}${own?.ratingDelta ?? "?"}) vs ${rivals.join(", ")}${flag}`,
    );
  });
  const preselected = matches
    .map((match, index) => (reportedMatches.has(match._id) ? String(index + 1) : null))
    .filter(Boolean);
  let chosen = null;
  while (!chosen) {
    chosen = pickMany(
      await ask("Partidas con trampa (números separados por coma, o 'todas')", preselected.join(",") || "1"),
      matches,
    );
    if (!chosen) errMsg(`Elegí números entre 1 y ${matches.length}.`);
  }

  const admin = await pickAdministrator();
  if (!admin) return;
  const report = await mongo("reports").findOne(
    { matchId: { $in: chosen.map((match) => match._id) }, reportedPlayerId: player.id },
    { projection: { _id: 1, matchId: 1 } },
  );
  if (report) info(`Se cita el reporte ${short(report._id)}… que denuncia la partida ${short(report.matchId)}….`);
  const type = await choose(
    "Tipo de sanción",
    ["permanent_ban", "temporary_suspension", "matchmaking_restriction"],
    (option) => option,
  );
  const failure = await choose("¿Simular una falla?", sanctionFailures, (option) => option.label);
  if (failure.explain) info(failure.explain);
  await submitSanction({ admin, chosen, failure, player, reportId: report?._id ?? null, type });
}

// Guided tour: the winner of the tour's match is sanctioned for it, with the failure half way and
// the resume right after, so the retention shows up without any question.
async function sanctionPreset({ failure, matchId, player }) {
  const match = await mongo("matches").findOne(
    { _id: matchId, scoringStatus: "applied", status: "closed" },
    { projection: { createdAt: 1, finalScoreboard: 1, mode: 1 } },
  );
  if (!match) {
    errMsg("La partida del recorrido no está cerrada con el scoring aplicado: no se puede anular.");
    return;
  }
  const admin = await pickAdministrator(true);
  info(`${player.username} hizo trampa en la partida ${short(matchId)}…: lo sanciona ${admin.username}.`);
  if (failure.explain) info(failure.explain);
  await submitSanction({
    admin,
    autoResume: true,
    chosen: [match],
    failure,
    player,
    reportId: null,
    type: "permanent_ban",
  });
}

async function submitSanction({ admin, autoResume = false, chosen, failure, player, reportId, type }) {
  const participants = [...new Set(chosen.flatMap((match) => match.finalScoreboard.map((s) => s.playerId)))];
  const before = await ratingsSnapshot(participants, chosen[0].mode);
  const body = {
    administratorId: admin._id,
    matchIds: chosen.map((match) => match._id),
    playerId: player.id,
    reason: "cheating",
    reportId,
    sanctionId: randomUUID(),
    type,
  };

  step("Primero se registra la sanción en MongoDB; después la reversión avanza paso a paso.");
  const sanction = await api("POST", "/sanctions", body, failure.headers);
  if (!sanction) {
    step("¿Quedó algo registrado?");
    show("MongoDB", `db.sanctions.findOne({ _id: "${short(body.sanctionId)}…" })`,
      await mongoFind("sanctions", { _id: body.sanctionId }));
    show("MongoDB", "estado de las partidas elegidas", await matchStates(body.matchIds));
    info("El pedido se rechazó antes de registrar la sanción: no hay nada que deshacer.");
    return;
  }
  await showSanctionState(body.sanctionId, before);

  if (sanction.reversal.status !== "completed") {
    info("La sanción ya está en vigor (el jugador no puede entrar a la cola) aunque la reversión no terminó.");
    info("Mientras tanto ningún leaderboard muestra la anulación a medias: los afectados están retenidos.");
    if (autoResume) {
      await pause();
      await resumeSanction(body.sanctionId, before);
    } else if (await confirm("¿Retomar la reversión ahora (POST /sanctions/:id/resume)?", true)) {
      await resumeSanction(body.sanctionId, before);
    } else {
      info("Se puede retomar después con la opción 10.");
    }
  }
}

async function resumeSanction(sanctionId, before) {
  step("El journal de la sanción dice qué falta: se rehace solo eso, sin revertir nada dos veces.");
  const resumed = await api("POST", `/sanctions/${sanctionId}/resume`);
  if (!resumed) return;
  await showSanctionState(sanctionId, before);
  if (resumed.reversal.status === "completed") {
    okMsg("Reversión completa: el leaderboard muestra a todos los afectados actualizados de una vez.");
  }
}

async function resumeIncompleteSanction() {
  title("Retomar una sanción incompleta  (problema 8)");
  if (!mongoDb) {
    errMsg("Se necesita MongoDB para buscar las sanciones.");
    return;
  }
  const pending = await mongo("sanctions")
    .find(
      { "reversal.status": { $in: ["pending", "reverting", "failed"] } },
      { projection: { createdAt: 1, playerId: 1, reversal: 1 } },
    )
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
  if (pending.length === 0) {
    okMsg("No hay sanciones con la reversión incompleta.");
    return;
  }
  const names = await usernames(pending.map((sanction) => sanction.playerId));
  const sanction = await choose("Sanción", pending, (doc) =>
    `${bold(short(doc._id))} ${names.get(doc.playerId) ?? short(doc.playerId)} ` +
      dim(`${doc.reversal.status}, ${doc.reversal.revertedMatchIds.length} partida(s) revertida(s)`),
  );
  await showSanctionState(sanction._id);
  await resumeSanction(sanction._id);
}

async function ratingsSnapshot(playerIds, mode) {
  const docs = await mongo("players")
    .find({ _id: { $in: playerIds } }, { projection: { [`ratings.${mode}.mmr`]: 1 } })
    .toArray();
  return new Map(docs.map((doc) => [doc._id, doc.ratings?.[mode]?.mmr ?? null]));
}

async function matchStates(matchIds) {
  const docs = await mongo("matches")
    .find({ _id: { $in: [...matchIds] } }, { projection: { status: 1, voided: 1 } })
    .toArray();
  return docs.map((doc) => ({
    partida: short(doc._id),
    estado: doc.status,
    anuladaPor: doc.voided ? short(doc.voided.sanctionId) : null,
  }));
}

// What each engine holds now for the sanction: the journal, the matches, ratings against the
// leaderboard, the history rows, the graph and the queue.
async function showSanctionState(sanctionId, before = new Map()) {
  const sanction = await mongo("sanctions").findOne({ _id: sanctionId });
  if (!sanction) {
    show("MongoDB", `db.sanctions.findOne({ _id: "${short(sanctionId)}…" })`, null);
    return;
  }
  const reversal = sanction.reversal ?? {};
  step("MongoDB: la sanción y el journal de la reversión.");
  show("MongoDB", `db.sanctions.findOne({ _id: "${short(sanctionId)}…" })`, {
    estado: sanction.status,
    tipo: sanction.type,
    reversion: {
      estado: reversal.status,
      intentos: reversal.attempts,
      pasosHechos: reversal.completedSteps,
      partidasRevertidas: `${reversal.revertedMatchIds?.length ?? 0} de ${sanction.matchIds?.length ?? 0}`,
      ultimoError: reversal.lastError,
    },
  });
  show("MongoDB", "estado de las partidas de la sanción", await matchStates(sanction.matchIds ?? []));

  const matches = await mongo("matches")
    .find(
      { _id: { $in: sanction.matchIds ?? [] } },
      { projection: { "closure.tsMs": 1, "finalScoreboard.playerId": 1, mode: 1 } },
    )
    .toArray();
  const participants = [...new Set(matches.flatMap((match) => match.finalScoreboard.map((s) => s.playerId)))];
  const names = await usernames(participants);
  const mode = matches[0]?.mode ?? "ranked_1v1";
  const season = await activeSeason();

  step("Rating en MongoDB contra lo que muestra el leaderboard en Redis:");
  const now = await ratingsSnapshot(participants, mode);
  const rows = [];
  for (const playerId of participants) {
    const row = {
      jugador: names.get(playerId) ?? short(playerId),
      ...(before.size > 0 ? { mmrAntes: before.get(playerId) ?? null } : {}),
      mmrMongo: now.get(playerId) ?? null,
    };
    if (season && db.redis) {
      const score = await db.redis.zscore(`lb:${season._id}:${mode}:global`, playerId);
      row.mmrLeaderboard = score === null ? "no figura" : Number(score);
      row.retenido = (await db.redis.hget(`lb:${season._id}:${mode}:held`, playerId)) !== null;
    }
    rows.push(row);
  }
  show("MongoDB + Redis", `ratings.${mode}.mmr  vs  ZSCORE lb:${season?._id ?? "?"}:${mode}:global`, rows);
  info("Si mmrMongo y mmrLeaderboard difieren con 'retenido: true', es la retención: el tablero espera a que");
  info("la reversión termine para mostrar a todos juntos. 'no figura' = se quedó sin partidas en la temporada.");

  step("Cassandra y Neo4j: ¿la partida anulada sigue en el historial y en el grafo?");
  const traces = [];
  for (const match of matches) {
    let historyRows = "(Cassandra no disponible)";
    if (db.cassandra && match.closure?.tsMs) {
      historyRows = 0;
      for (const { playerId } of match.finalScoreboard) {
        const found = await cassandraRows(
          "SELECT match_id FROM match_history_by_player WHERE player_id = ? AND ended_at = ? AND match_id = ?",
          [playerId, new Date(match.closure.tsMs), match._id],
        );
        historyRows += Array.isArray(found) ? found.length : 0;
      }
    }
    const node = await neo4jRows("MATCH (m:Match {id: $id}) RETURN count(m) AS nodos", { id: match._id });
    traces.push({
      partida: short(match._id),
      filasEnHistorial: historyRows,
      nodoEnGrafo: Array.isArray(node) ? node[0]?.nodos > 0 : node,
    });
  }
  show("Cassandra + Neo4j", "match_history_by_player y (:Match {id})", traces);

  if (db.redis) {
    show("Redis", `EXISTS mm:ticket:${short(sanction.playerId)}…  (cola de matchmaking)`, {
      enCola: (await db.redis.exists(`mm:ticket:${sanction.playerId}`)) === 1,
    });
  }
}

// ---------------------------------------------------------------------------
// 11. Recorrido guiado: todo el flujo con datos mínimos, hasta la sanción
// ---------------------------------------------------------------------------

async function guidedTour() {
  title("Recorrido guiado: de registrar jugadores a la sanción");
  const country = (await ask("País de los dos jugadores", "AR")).toUpperCase();
  const base = (await ask("Prefijo de los nombres de usuario", "demo")).toLowerCase();
  const mode = "ranked_1v1";
  const suffix = randomUUID().slice(0, 4);

  const players = [];
  for (const name of ["a", "b"]) {
    const player = await registerPlayer({ country, username: `${base}_${name}_${suffix}` });
    if (!player) return;
    players.push(player);
    await pause();
  }
  for (const player of players) {
    if (!(await enqueuePlayer(player, mode))) return;
    await pause();
  }
  const match = await formMatch(mode, players[0].region);
  if (!match) return;
  await pause();

  const [a, b] = match.players;
  const now = Date.now();
  await recordEvent(match, { eventId: randomUUID(), playerId: a, targetPlayerId: b, tsMs: now, type: "kill" });
  await pause();
  await recordEvent(match, { eventId: randomUUID(), playerId: a, points: 5, tsMs: now + 1, type: "objective" });
  await pause();
  await recordEvent(
    match,
    { eventId: randomUUID(), playerId: b, targetPlayerId: a, tsMs: now + 2, type: "kill" },
    true,
  );
  await pause();

  await finishMatch(match, [
    { playerId: a, result: "win" },
    { playerId: b, result: "loss" },
  ]);
  await pause();
  await projectClosedMatches(players[0]);
  await pause();

  // Problem 8: the winner turns out to have cheated. The match is already in the four engines
  // (MongoDB, the Redis leaderboard, the Cassandra history and the Neo4j graph), so voiding it
  // touches all of them; the failure half way shows the leaderboard held until the resume.
  const winner = players.find((player) => player.id === a) ?? players[0];
  await sanctionPlayer({ failure: sanctionFailures[1], matchId: match.matchId, player: winner });
  await pause();
  await showProfile(winner);
  okMsg("Recorrido completo.");
}

// ---------------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------------

async function engineStatus() {
  title("Estado de los motores");
  const ready = await call("GET", "/ready").catch(() => ({ status: "sin respuesta" }));
  show("API", `GET ${APP_URL}/ready`, ready.body ?? ready.status);
  if (mongoDb) {
    show("MongoDB", "cantidad de documentos", {
      jugadores: await mongo("players").estimatedDocumentCount(),
      partidas: await mongo("matches").estimatedDocumentCount(),
      sanciones: await mongo("sanctions").estimatedDocumentCount(),
      temporadaActiva: (await activeSeason())?._id ?? null,
    });
  }
  if (db.redis) show("Redis", "DBSIZE", { claves: await db.redis.dbsize() });
  if (db.cassandra) {
    show("Cassandra", "tablas del keyspace gaming", await cassandraRows(
      "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?", ["gaming"]));
  }
  if (db.neo4j) {
    show("Neo4j", "MATCH (n) RETURN labels(n), count(*)", await neo4jRows(
      "MATCH (n) RETURN labels(n)[0] AS etiqueta, count(*) AS cantidad", {}));
  }
}

// ---------------------------------------------------------------------------
// 13. Limpiar bases e inicializar datos (gamingApp/src/scripts/seed.ts --reset)
// ---------------------------------------------------------------------------

async function resetAndSeed() {
  title("Limpiar bases e inicializar datos  ->  los cuatro motores desde cero");
  info("Borra jugadores, partidas, reportes, sanciones y administradores (MongoDB), todo Redis,");
  info("las tablas de Cassandra y el grafo de Neo4j. Los catálogos y el esquema se conservan.");
  info("Después carga 2.000 jugadores, 50.000 partidas cerradas y los casos de los problemas 7 y 8.");
  if (!(await confirm("¿Seguro? Se pierde todo lo cargado", false))) return;

  // The seed reads its configuration from the environment: the same engines this console reads.
  const seedEnv = {
    ...process.env,
    CASSANDRA_CONTACT_POINTS: CASSANDRA_HOST,
    CASSANDRA_PORT: String(CASSANDRA_PORT),
    MONGODB_DB_NAME,
    MONGODB_URI,
    NEO4J_PASSWORD,
    NEO4J_URI,
    NEO4J_USERNAME,
    REDIS_URL,
  };
  const started = performance.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/scripts/seed.ts", "--reset"], {
      cwd: new URL("../gamingApp/", import.meta.url),
      env: seedEnv,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    errMsg(`La carga terminó con código ${code}.`);
    return;
  }
  session.players.length = 0;
  session.matches.length = 0;
  okMsg(`Bases limpias y datos cargados en ${((performance.now() - started) / 1000).toFixed(0)} s.`);
  info('Los jugadores cargados se buscan por nombre: "seed_player_0" ... "seed_player_1999".');
  await engineStatus();
}

const menu = [
  ["Registrar jugador                      (MongoDB)", () => registerPlayer()],
  ["Poner jugador en la cola               (MongoDB -> Redis)", () => enqueuePlayer()],
  ["Formar partida                         (Redis + MongoDB)", () => formMatch()],
  ["Registrar evento en una partida        (Cassandra + Redis a la vez)", () => recordEvent()],
  ["Cerrar partida y aplicar rating        (Redis, Cassandra, MongoDB)", () => finishMatch()],
  ["Ver leaderboard                        (Redis + MongoDB)", () => showLeaderboard()],
  ["Proyectar historial y grafo            (MongoDB -> Cassandra y Neo4j)", () => projectClosedMatches()],
  ["Perfil completo de un jugador          (MongoDB + Redis + Cassandra)", () => showProfile()],
  ["Sancionar jugador y anular partidas    (MongoDB, Redis, Cassandra y Neo4j)", () => sanctionPlayer()],
  ["Retomar una sanción incompleta         (resume desde el journal)", () => resumeIncompleteSanction()],
  ["Recorrido guiado completo              (todo lo anterior, paso a paso)", () => guidedTour()],
  ["Estado de los motores", () => engineStatus()],
  ["Limpiar bases e inicializar datos      (los cuatro motores desde cero)", () => resetAndSeed()],
];

async function main() {
  console.clear();
  title("TP Bases de Datos II  -  Plataforma de matchmaking");
  console.log(
    `   Una API y cuatro motores: ${engines.MongoDB("MongoDB")}, ${engines.Redis("Redis")}, ` +
      `${engines.Cassandra("Cassandra")} y ${engines.Neo4j("Neo4j")}.`,
  );
  info("Las bases no se hablan entre sí: toda la comunicación pasa por la aplicación.");
  await connectEngines();

  while (true) {
    console.log();
    line();
    console.log(bold("   MENÚ"));
    line();
    menu.forEach(([label], index) => console.log(`   ${bold(String(index + 1).padStart(2))}) ${label}`));
    console.log(`   ${bold(" 0")}) Salir`);
    if (session.players.length > 0 || session.matches.length > 0) {
      info(`Sesión: ${session.players.length} jugador(es), ${session.matches.length} partida(s).`);
    }
    const answer = (await rl.question(bold("\n   Opción: "))).trim();
    if (answer === "0" || answer.toLowerCase() === "salir") break;
    const entry = menu[Number(answer) - 1];
    if (!entry) {
      errMsg("Opción inválida.");
      continue;
    }
    try {
      await entry[1]();
    } catch (error) {
      if (error.code === "ERR_USE_AFTER_CLOSE" || error.code === "ABORT_ERR") throw error;
      errMsg(error.cause?.code === "ECONNREFUSED" ? `La API no responde en ${APP_URL}.` : error.message);
    }
    await pause();
  }
}

// Leaving the menu, Ctrl+C or the end of the input all close readline; a pending question would
// never resolve, so the connections are closed and the process ends from here.
rl.on("close", async () => {
  console.log(dim("\n   Cerrando conexiones..."));
  await Promise.allSettled([
    db.mongo?.close(),
    db.redis?.quit(),
    db.cassandra?.shutdown(),
    db.neo4j?.close(),
  ]);
  process.exit(0);
});

try {
  await main();
} catch (error) {
  if (error.code !== "ERR_USE_AFTER_CLOSE" && error.code !== "ABORT_ERR") throw error;
}
rl.close();
