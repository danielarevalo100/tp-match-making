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
    console.log(`   ${yellow(`HTTP ${response.status}  falla simulada en "${response.body.step}" (esperada)`)}`);
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

async function showProfile() {
  title("Perfil completo  ->  MongoDB + Redis + Cassandra en una consulta  (problema 8)");
  const player = await pickPlayer();
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
// 9. Recorrido guiado: todo el flujo con datos mínimos
// ---------------------------------------------------------------------------

async function guidedTour() {
  title("Recorrido guiado: de registrar jugadores a la partida cerrada");
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

const menu = [
  ["Registrar jugador                      (MongoDB)", () => registerPlayer()],
  ["Poner jugador en la cola               (MongoDB -> Redis)", () => enqueuePlayer()],
  ["Formar partida                         (Redis + MongoDB)", () => formMatch()],
  ["Registrar evento en una partida        (Cassandra + Redis a la vez)", () => recordEvent()],
  ["Cerrar partida y aplicar rating        (Redis, Cassandra, MongoDB)", () => finishMatch()],
  ["Ver leaderboard                        (Redis + MongoDB)", () => showLeaderboard()],
  ["Proyectar historial y grafo            (MongoDB -> Cassandra y Neo4j)", () => projectClosedMatches()],
  ["Perfil completo de un jugador          (MongoDB + Redis + Cassandra)", () => showProfile()],
  ["Recorrido guiado completo              (todo lo anterior, paso a paso)", () => guidedTour()],
  ["Estado de los motores", () => engineStatus()],
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
