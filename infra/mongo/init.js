// This script runs only when MongoDB initializes a new data volume.
// Keep operations idempotent so the same statements can later be reused by a
// dedicated schema command (scripts/initialize-infrastructure.*).
//
// MongoDB is the source of truth for durable domain data: players (with their
// rating per game mode), static catalogs (regions, game modes, seasons),
// administrators, reports and sanctions. Live state (matchmaking queues,
// matches in progress, leaderboards) lives in Redis; match history and events
// live in Cassandra. See infra/mongo/README.md.

const gamingDb = db.getSiblingDB("gaming");

const NUMBER = ["int", "long", "double", "decimal"];
const INTEGER = ["int", "long"];

// Creates the collection with its validator, or updates the validator if the
// collection already exists.
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

// Upserts static catalog documents so that reapplying the script also
// propagates changes made to the definitions below.
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
// regions (static catalog)
// A player's region is derived from their country, so each country belongs to
// exactly one region (unique multikey index on `countries`).
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
// game_modes (static catalog)
// minPlayers/maxPlayers define how many participations a match has. The
// matchmaking block parametrizes match formation (problem 2): the accepted
// rating range starts at initialRatingRange and grows by ratingRangeStep every
// expandEverySeconds of waiting, up to maxRatingRange.
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
// seasons (static catalog)
// At most one season can be active at a time (partial unique index).
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
// `_id` is the shared identifier used by every engine (Redis keys, Cassandra
// partitions, Neo4j nodes). `region` is derived from `country` at
// registration. `ratings` holds the current rating per game mode, keyed by
// game_modes._id (e.g. ratings.ranked_5v5.mmr); historical snapshots
// (mmr_before / mmr_after) live with the match history, not here.
// `accountStatus` only describes the account lifecycle: sanctions are kept in
// their own collection and are the only source for "is this player
// sanctioned?".
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
    // Problem 8: voided matches whose rating adjustment was already taken back. Same role as
    // appliedRatingMatches: the guard that makes the reversal idempotent per (match, player).
    revertedRatingMatches: {
      bsonType: "array",
      description:
        "Voided match ids whose rating adjustment was already reverted",
      uniqueItems: true,
      items: { bsonType: "string" },
    },
    // Leaderboard standing per season and mode (problem 5), written by problem 4 in the same
    // update as `ratings`: seasonRatings.<seasonId>.<modeId>. `mmr` is the mode rating after the
    // player's last match of that season, `region` the player's region at that moment and
    // `revision` grows on every change so Redis can ignore stale writes. `gamesPlayed` can drop
    // to 0 when problem 8 voids every match the player had in the season: the standing is kept
    // (so `revision` keeps growing) but it is no longer ranked.
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

// Version 3 migration: normalize existing identifiers and backfill updatedAt.
// A case-insensitive collision intentionally fails against the unique indexes
// and must be resolved explicitly instead of silently merging accounts.
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
// reporterPlayerId is null for automatic reports. assignedAdminId stays null
// until an administrator takes the report.
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
// Problem 7: reports received by any player inside a time window.
gamingDb.reports.createIndex({ createdAt: 1 });

// ---------------------------------------------------------------------------
// sanctions
// A sanction is in force when status = "active", startsAt <= now and
// (endsAt is null or endsAt > now). endsAt = null means permanent.
// All sanction types block matchmaking (problem 1).
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
    // Problem 8: matches whose results the sanction voids, and the journal of that reversal.
    // The sanction is in force as soon as it is inserted; the reversal only moves forward and
    // records each finished step, so after a crash it is clear what is left to complete.
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

// Supports the "sanction in force" check used by problem 1.
gamingDb.sanctions.createIndex({ playerId: 1, status: 1, endsAt: 1 });
gamingDb.sanctions.createIndex({ playerId: 1, createdAt: -1 });
gamingDb.sanctions.createIndex({ reportId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// matches (problem 2)
// Durable record of a match created by the formation saga. `_id` is the shared
// matchId (also the Redis key suffix and the Cassandra partition later), so
// retrying the creation never duplicates it. Problem 4 closes it. Problem 8
// moves it from closed to voided and records `voided: { sanctionId, at }`.
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
// Schema versions
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
