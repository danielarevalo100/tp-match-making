// This script runs only when MongoDB initializes a new data volume.
// Keep operations idempotent so the same statements can later be reused by a
// dedicated schema command.

const gamingDb = db.getSiblingDB("gaming");

if (!gamingDb.getCollectionNames().includes("schema_metadata")) {
  gamingDb.createCollection("schema_metadata");
}

gamingDb.schema_metadata.createIndex({ version: 1 }, { unique: true });
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
