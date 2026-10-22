// Este script corre solo cuando MongoDB inicializa un volumen de datos nuevo. Las operaciones son
// idempotentes, así las mismas sentencias se pueden reaplicar con el comando de esquema
// (scripts/initialize-infrastructure.*).
//
// MongoDB es la fuente de verdad de los datos durables del dominio: jugadores (con su rating por
// modo de juego), catálogos estáticos (regiones, modos de juego, temporadas), administradores,
// reportes y sanciones. El estado en vivo (colas de matchmaking, partidas en curso, leaderboards)
// vive en Redis; el historial y los eventos de partidas, en Cassandra. Ver infra/mongo/README.md.

const gamingDb = db.getSiblingDB("gaming");

const NUMBER = ["int", "long", "double", "decimal"];
const INTEGER = ["int", "long"];

// Crea la colección con su validador, o actualiza el validador si la colección ya existe.
function ensureCollection(name, schema) {
  const options = {
    validator: { $jsonSchema: schema },
    validationLevel: "strict",
    validationAction: "error",
  };

  if (gamingDb.getCollectionNames().includes(name)) {
    gamingDb.runCommand({ collMod: name, ...options });
  } else {
    gamingDb.createCollection(name, options);
  }
}

// Inserta o actualiza los documentos de catálogo, así reaplicar el script también propaga los
// cambios hechos a las definiciones de abajo.
function upsertCatalog(collection, documents) {
  for (const { _id, ...fields } of documents) {
    gamingDb[collection].updateOne({ _id }, { $set: fields }, { upsert: true });
  }
}

// ---------------------------------------------------------------------------
// schema_metadata
// ---------------------------------------------------------------------------

if (!gamingDb.getCollectionNames().includes("schema_metadata")) {
  gamingDb.createCollection("schema_metadata");
}

gamingDb.schema_metadata.createIndex({ version: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// regions (catálogo estático)
// La región de un jugador sale de su país, así que cada país pertenece a exactamente una región
// (índice multikey único sobre `countries`).
// ---------------------------------------------------------------------------

ensureCollection("regions", {
  bsonType: "object",
  required: ["_id", "name", "countries", "active"],
  additionalProperties: false,
  properties: {
    _id: { bsonType: "string", description: "Region code, e.g. LATAM" },
    name: { bsonType: "string" },
    countries: {
      bsonType: "array",
      minItems: 1,
      uniqueItems: true,
      items: { bsonType: "string", pattern: "^[A-Z]{2}$" },
      description: "ISO 3166-1 alpha-2 country codes",
    },
    active: { bsonType: "bool" },
  },
});

gamingDb.regions.createIndex({ countries: 1 }, { unique: true });

upsertCatalog("regions", [
  { _id: "NA", name: "North America", countries: ["US", "CA"], active: true },
  {
    _id: "LATAM",
    name: "Latin America",
    countries: [
      "AR",
      "BO",
      "CL",
      "CO",
      "CR",
      "EC",
      "MX",
      "PE",
      "PY",
      "UY",
      "VE",
    ],
    active: true,
  },
  { _id: "BR", name: "Brazil", countries: ["BR"], active: true },
  {
    _id: "EU",
    name: "Europe",
    countries: ["DE", "ES", "FR", "GB", "IT", "NL", "PL", "PT", "SE"],
    active: true,
  },
  {
    _id: "ASIA",
    name: "Asia",
    countries: ["CN", "IN", "JP", "KR", "SG"],
    active: true,
  },
  { _id: "OCE", name: "Oceania", countries: ["AU", "NZ"], active: true },
]);

// ---------------------------------------------------------------------------
// game_modes (catálogo estático)
// minPlayers/maxPlayers definen cuántos participantes tiene una partida. El bloque matchmaking
// parametriza la formación de partidas (problema 2): el rango de rating aceptado empieza en
// initialRatingRange y crece ratingRangeStep cada expandEverySeconds de espera, hasta maxRatingRange.
// ---------------------------------------------------------------------------

ensureCollection("game_modes", {
  bsonType: "object",
  required: [
    "_id",
    "name",
    "minPlayers",
    "maxPlayers",
    "teams",
    "ranked",
    "active",
    "matchmaking",
  ],
  additionalProperties: false,
  properties: {
    _id: { bsonType: "string", description: "Mode code, e.g. ranked_5v5" },
    name: { bsonType: "string" },
    description: { bsonType: "string" },
    minPlayers: { bsonType: INTEGER, minimum: 2 },
    maxPlayers: { bsonType: INTEGER, minimum: 2 },
    teams: { bsonType: INTEGER, minimum: 0, description: "0 = free for all" },
    ranked: { bsonType: "bool" },
    active: { bsonType: "bool" },
    initialRating: { bsonType: NUMBER },
    matchmaking: {
      bsonType: "object",
      required: [
        "initialRatingRange",
        "ratingRangeStep",
        "expandEverySeconds",
        "maxRatingRange",
      ],
      additionalProperties: false,
      properties: {
        initialRatingRange: { bsonType: NUMBER, minimum: 0 },
        ratingRangeStep: { bsonType: NUMBER, minimum: 0 },
        expandEverySeconds: { bsonType: INTEGER, minimum: 1 },
        maxRatingRange: { bsonType: NUMBER, minimum: 0 },
      },
    },
  },
});

gamingDb.game_modes.createIndex({ name: 1 }, { unique: true });

upsertCatalog("game_modes", [
  {
    _id: "ranked_1v1",
    name: "Ranked 1v1",
    description: "Ranked duel between two players",
    minPlayers: 2,
    maxPlayers: 2,
    teams: 2,
    ranked: true,
    active: true,
    initialRating: 1000,
    matchmaking: {
      initialRatingRange: 50,
      ratingRangeStep: 50,
      expandEverySeconds: 15,
      maxRatingRange: 400,
    },
  },
  {
    _id: "ranked_5v5",
    name: "Ranked 5v5",
    description: "Ranked match between two teams of five",
    minPlayers: 10,
    maxPlayers: 10,
    teams: 2,
    ranked: true,
    active: true,
    initialRating: 1000,
    matchmaking: {
      initialRatingRange: 100,
      ratingRangeStep: 50,
      expandEverySeconds: 20,
      maxRatingRange: 500,
    },
  },
  {
    _id: "casual_5v5",
    name: "Casual 5v5",
    description: "Unranked match between two teams of five",
    minPlayers: 10,
    maxPlayers: 10,
    teams: 2,
    ranked: false,
    active: true,
    initialRating: 1000,
    matchmaking: {
      initialRatingRange: 200,
      ratingRangeStep: 100,
      expandEverySeconds: 10,
      maxRatingRange: 1000,
    },
  },
  {
    _id: "battle_royale",
    name: "Battle Royale",
    description: "Ranked free for all, last player standing wins",
    minPlayers: 20,
    maxPlayers: 50,
    teams: 0,
    ranked: true,
    active: true,
    initialRating: 1000,
    matchmaking: {
      initialRatingRange: 150,
      ratingRangeStep: 75,
      expandEverySeconds: 15,
      maxRatingRange: 600,
    },
  },
]);

// ---------------------------------------------------------------------------
// seasons (catálogo estático)
// Puede haber a lo sumo una temporada activa a la vez (índice único parcial).
// ---------------------------------------------------------------------------

ensureCollection("seasons", {
  bsonType: "object",
  required: ["_id", "name", "startsAt", "endsAt", "status"],
  additionalProperties: false,
  properties: {
    _id: { bsonType: "string", description: "Season code, e.g. 2026-S2" },
    name: { bsonType: "string" },
    startsAt: { bsonType: "date" },
    endsAt: { bsonType: "date" },
    status: { enum: ["scheduled", "active", "closed"] },
  },
});

gamingDb.seasons.createIndex({ name: 1 }, { unique: true });
gamingDb.seasons.createIndex(
  { status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
    name: "one_active_season",
  },
);
gamingDb.seasons.createIndex({ startsAt: 1 });

upsertCatalog("seasons", [
  {
    _id: "2026-S1",
    name: "Season 1 2026",
    startsAt: ISODate("2026-01-01T00:00:00Z"),
    endsAt: ISODate("2026-06-30T23:59:59Z"),
    status: "closed",
  },
  {
    _id: "2026-S2",
    name: "Season 2 2026",
    startsAt: ISODate("2026-07-01T00:00:00Z"),
    endsAt: ISODate("2026-12-31T23:59:59Z"),
    status: "active",
  },
]);

// ---------------------------------------------------------------------------
// players
// `_id` es el identificador compartido que usan todas las bases (claves de Redis, particiones de
// Cassandra, nodos de Neo4j). `region` se calcula desde `country` al registrarse. `ratings` tiene
// el rating actual por modo de juego, con clave game_modes._id (por ejemplo ratings.ranked_5v5.mmr);
// las fotos históricas (mmr_before / mmr_after) viven con el historial de partidas, no acá.
// `accountStatus` solo describe el ciclo de vida de la cuenta: las sanciones están en su propia
// colección y son la única fuente para saber si un jugador está sancionado.
// ---------------------------------------------------------------------------

ensureCollection("players", {
  bsonType: "object",
  required: [
    "_id",
    "username",
    "email",
    "passwordHash",
    "registeredAt",
    "updatedAt",
    "country",
    "region",
    "level",
    "accountStatus",
    "ratings",
  ],
  additionalProperties: false,
  properties: {
    _id: { bsonType: "string", description: "Shared player id (UUID)" },
    username: {
      bsonType: "string",
      minLength: 3,
      maxLength: 32,
      pattern: "^[^A-Z]+$",
    },
    email: { bsonType: "string", pattern: "^[^@\\sA-Z]+@[^@\\sA-Z]+$" },
    passwordHash: { bsonType: "string" },
    birthDate: { bsonType: "date" },
    registeredAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
    country: { bsonType: "string", pattern: "^[A-Z]{2}$" },
    region: {
      bsonType: "string",
      description: "regions._id derived from country",
    },
    level: { bsonType: INTEGER, minimum: 1 },
    accountStatus: { enum: ["active", "inactive", "closed"] },
    avatarUrl: { bsonType: "string" },
    ratings: {
      bsonType: "object",
      description: "Current rating per game mode, keyed by game_modes._id",
      additionalProperties: {
        bsonType: "object",
        required: ["mmr", "gamesPlayed", "updatedAt"],
        additionalProperties: false,
        properties: {
          mmr: { bsonType: NUMBER },
          gamesPlayed: { bsonType: INTEGER, minimum: 0 },
          updatedAt: { bsonType: "date" },
        },
      },
    },
    appliedRatingMatches: {
      bsonType: "array",
      description:
        "Match ids whose eventual rating adjustment was already applied",
      uniqueItems: true,
      items: { bsonType: "string" },
    },
    // Problema 8: partidas anuladas cuyo ajuste de rating ya se deshizo. Mismo rol que
    // appliedRatingMatches: la guarda que hace idempotente la reversión por (partida, jugador).
    revertedRatingMatches: {
      bsonType: "array",
      description:
        "Voided match ids whose rating adjustment was already reverted",
      uniqueItems: true,
      items: { bsonType: "string" },
    },
    // Standing del leaderboard por temporada y modo (problema 5), lo escribe el problema 4 en el
    // mismo update que `ratings`: seasonRatings.<seasonId>.<modeId>. `mmr` es el rating del modo
    // después de la última partida del jugador en esa temporada, `region` la región del jugador en
    // ese momento y `revision` crece en cada cambio para que Redis ignore escrituras viejas.
    // `gamesPlayed` puede bajar a 0 cuando el problema 8 anula todas las partidas del jugador en la
    // temporada: el standing se conserva (así `revision` sigue creciendo) pero ya no se rankea.
    seasonRatings: {
      bsonType: "object",
      description: "Leaderboard standing per season, then per game mode",
      additionalProperties: {
        bsonType: "object",
        additionalProperties: {
          bsonType: "object",
          required: ["mmr", "gamesPlayed", "region", "revision", "updatedAt"],
          additionalProperties: false,
          properties: {
            mmr: { bsonType: NUMBER },
            gamesPlayed: { bsonType: INTEGER, minimum: 0 },
            region: { bsonType: "string" },
            revision: { bsonType: INTEGER, minimum: 1 },
            updatedAt: { bsonType: "date" },
          },
        },
      },
    },
  },
});

gamingDb.players.createIndex({ username: 1 }, { unique: true });
gamingDb.players.createIndex({ email: 1 }, { unique: true });
gamingDb.players.createIndex({ region: 1, registeredAt: 1 });
gamingDb.players.createIndex({ country: 1 });

// Migración de la versión 3: normaliza los identificadores existentes y completa updatedAt.
// Una colisión sin distinguir mayúsculas falla a propósito contra los índices únicos y hay que
// resolverla a mano, en lugar de fusionar cuentas en silencio.
gamingDb.players.updateMany({}, [
  {
    $set: {
      username: { $toLower: "$username" },
      email: { $toLower: "$email" },
      updatedAt: { $ifNull: ["$updatedAt", "$registeredAt"] },
    },
  },
]);

// ---------------------------------------------------------------------------
// administrators
// ---------------------------------------------------------------------------

ensureCollection("administrators", {
  bsonType: "object",
  required: [
    "_id",
    "username",
    "email",
    "permissionLevel",
    "createdAt",
    "active",
  ],
  additionalProperties: false,
  properties: {
    _id: { bsonType: "string", description: "Shared administrator id (UUID)" },
    username: { bsonType: "string", minLength: 3, maxLength: 32 },
    email: { bsonType: "string", pattern: "^[^@\\s]+@[^@\\s]+$" },
    permissionLevel: { enum: ["moderator", "senior_moderator", "admin"] },
    createdAt: { bsonType: "date" },
    active: { bsonType: "bool" },
  },
});

gamingDb.administrators.createIndex({ username: 1 }, { unique: true });
gamingDb.administrators.createIndex({ email: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// reports
// reporterPlayerId es null en los reportes automáticos. assignedAdminId queda null hasta que un
// administrador toma el reporte.
// ---------------------------------------------------------------------------

ensureCollection("reports", {
  bsonType: "object",
  required: [
    "_id",
    "reportedPlayerId",
    "reporterPlayerId",
    "reason",
    "createdAt",
    "status",
  ],
  additionalProperties: false,
  properties: {
    _id: { bsonType: "string", description: "Shared report id (UUID)" },
    reportedPlayerId: { bsonType: "string" },
    reporterPlayerId: {
      bsonType: ["string", "null"],
      description: "null = automatic report",
    },
    matchId: { bsonType: ["string", "null"] },
    assignedAdminId: { bsonType: ["string", "null"] },
    reason: {
      enum: [
        "cheating",
        "match_fixing",
        "toxicity",
        "griefing",
        "afk",
        "other",
      ],
    },
    description: { bsonType: "string" },
    createdAt: { bsonType: "date" },
    status: { enum: ["open", "assigned", "resolved", "dismissed"] },
  },
});

gamingDb.reports.createIndex({ reportedPlayerId: 1, createdAt: -1 });
gamingDb.reports.createIndex({ status: 1, createdAt: 1 });
gamingDb.reports.createIndex({ matchId: 1 }, { sparse: true });
// Problema 7: reportes recibidos por cualquier jugador dentro de una ventana de tiempo.
gamingDb.reports.createIndex({ createdAt: 1 });

// ---------------------------------------------------------------------------
// sanctions
// Una sanción está en vigor cuando status = "active", startsAt <= ahora y (endsAt es null o
// endsAt > ahora). endsAt = null significa permanente. Todos los tipos de sanción bloquean el
// matchmaking (problema 1).
// ---------------------------------------------------------------------------

ensureCollection("sanctions", {
  bsonType: "object",
  required: [
    "_id",
    "playerId",
    "adminId",
    "type",
    "reason",
    "startsAt",
    "endsAt",
    "status",
    "createdAt",
  ],
  additionalProperties: false,
  properties: {
    _id: { bsonType: "string", description: "Shared sanction id (UUID)" },
    playerId: { bsonType: "string" },
    adminId: { bsonType: "string" },
    reportId: { bsonType: ["string", "null"] },
    type: {
      enum: [
        "matchmaking_restriction",
        "temporary_suspension",
        "permanent_ban",
      ],
    },
    reason: { bsonType: "string" },
    description: { bsonType: "string" },
    startsAt: { bsonType: "date" },
    endsAt: { bsonType: ["date", "null"], description: "null = permanent" },
    status: { enum: ["active", "expired", "revoked"] },
    createdAt: { bsonType: "date" },
    // Problema 8: partidas cuyos resultados anula la sanción, y el journal de esa reversión. La
    // sanción está en vigor apenas se inserta; la reversión solo avanza y anota cada paso
    // terminado, así después de una caída queda claro qué falta completar.
    matchIds: {
      bsonType: "array",
      uniqueItems: true,
      items: { bsonType: "string" },
    },
    reversal: {
      bsonType: "object",
      required: [
        "status",
        "attempts",
        "completedSteps",
        "heldBoards",
        "revertedMatchIds",
        "lastError",
        "updatedAt",
        "completedAt",
      ],
      additionalProperties: false,
      properties: {
        status: { enum: ["pending", "reverting", "completed", "failed"] },
        attempts: { bsonType: INTEGER, minimum: 0 },
        completedSteps: {
          bsonType: "array",
          uniqueItems: true,
          items: { enum: ["queue", "hold", "leaderboard"] },
        },
        heldBoards: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["seasonId", "mode", "playerIds"],
            additionalProperties: false,
            properties: {
              seasonId: { bsonType: "string" },
              mode: { bsonType: "string" },
              playerIds: { bsonType: "array", items: { bsonType: "string" } },
            },
          },
        },
        revertedMatchIds: {
          bsonType: "array",
          uniqueItems: true,
          items: { bsonType: "string" },
        },
        lastError: { bsonType: ["string", "null"] },
        updatedAt: { bsonType: "date" },
        completedAt: { bsonType: ["date", "null"] },
      },
    },
  },
});

// Resuelve el chequeo de "sanción en vigor" que usa el problema 1.
gamingDb.sanctions.createIndex({ playerId: 1, status: 1, endsAt: 1 });
gamingDb.sanctions.createIndex({ playerId: 1, createdAt: -1 });
gamingDb.sanctions.createIndex({ reportId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// matches (problema 2)
// Registro durable de una partida creada por la saga de formación. `_id` es el matchId compartido
// (también el sufijo de la clave en Redis y después la partición en Cassandra), así reintentar la
// creación nunca la duplica. El problema 4 la cierra. El problema 8 la pasa de closed a voided y
// guarda `voided: { sanctionId, at }`.
// ---------------------------------------------------------------------------

ensureCollection("matches", {
  bsonType: "object",
  required: [
    "_id",
    "mode",
    "region",
    "status",
    "players",
    "ratingRange",
    "createdAt",
  ],
  additionalProperties: true,
  properties: {
    _id: { bsonType: "string", description: "Shared match id (UUID)" },
    mode: { bsonType: "string" },
    region: { bsonType: "string" },
    status: { enum: ["in_progress", "closing", "closed", "voided"] },
    ratingRange: { bsonType: NUMBER },
    createdAt: { bsonType: "date" },
    players: {
      bsonType: "array",
      minItems: 2,
      items: {
        bsonType: "object",
        required: ["playerId", "mmr", "enqueuedAt"],
        properties: {
          playerId: { bsonType: "string" },
          mmr: { bsonType: NUMBER },
          enqueuedAt: { bsonType: NUMBER },
        },
      },
    },
  },
});

gamingDb.matches.createIndex({ status: 1, createdAt: 1 });
gamingDb.matches.createIndex({ "players.playerId": 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// Versiones del esquema
// ---------------------------------------------------------------------------

gamingDb.schema_metadata.updateOne(
  { version: 1 },
  {
    $setOnInsert: {
      description: "Initial infrastructure schema",
      appliedAt: new Date(),
    },
  },
  { upsert: true },
);
gamingDb.schema_metadata.updateOne(
  { version: 2 },
  {
    $setOnInsert: {
      description:
        "Players, catalogs (regions, game modes, seasons), administrators, reports and sanctions",
      appliedAt: new Date(),
    },
  },
  { upsert: true },
);
gamingDb.schema_metadata.updateOne(
  { version: 3 },
  {
    $setOnInsert: {
      description: "Normalize player identifiers and track profile updates",
      appliedAt: new Date(),
    },
  },
  { upsert: true },
);
gamingDb.schema_metadata.updateOne(
  { version: 4 },
  {
    $setOnInsert: {
      description: "Matches created by the matchmaking formation saga",
      appliedAt: new Date(),
    },
  },
  { upsert: true },
);
gamingDb.schema_metadata.updateOne(
  { version: 5 },
  {
    $setOnInsert: {
      description: "Idempotent match closure and eventual rating adjustments",
      appliedAt: new Date(),
    },
  },
  { upsert: true },
);
gamingDb.schema_metadata.updateOne(
  { version: 6 },
  {
    $setOnInsert: {
      description:
        "Season leaderboard standings per player and leaderboard publication per match",
      appliedAt: new Date(),
    },
  },
  { upsert: true },
);
gamingDb.schema_metadata.updateOne(
  { version: 7 },
  {
    $setOnInsert: {
      description:
        "Index of reports by creation date for irregular behavior detection",
      appliedAt: new Date(),
    },
  },
  { upsert: true },
);
gamingDb.schema_metadata.updateOne(
  { version: 8 },
  {
    $setOnInsert: {
      description:
        "Sanction with result reversal: reversal journal, reverted ratings and unranked standings",
      appliedAt: new Date(),
    },
  },
  { upsert: true },
);
