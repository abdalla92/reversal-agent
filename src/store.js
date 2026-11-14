import { MongoClient } from "mongodb";
import { DB_NAME, mongoOptions, requireMongoUri } from "./config.js";

let client;

const auditValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["tenantId", "runId", "actorId", "tool", "outcome", "at"],
    properties: {
      tenantId: { bsonType: "string" },
      runId: { bsonType: "string" },
      actorId: { bsonType: "string" },
      tool: { bsonType: "string" },
      outcome: { enum: ["allowed", "denied", "idempotent", "verified"] },
      at: { bsonType: "date" },
    },
  },
};

export async function connect() {
  if (!client) {
    client = new MongoClient(requireMongoUri(), mongoOptions);
    await client.connect();
  }
  return client.db(DB_NAME);
}

export async function close() {
  if (client) {
    await client.close();
    client = undefined;
  }
}

async function ensureCollection(db, name, validator) {
  const exists = await db.listCollections({ name }).hasNext();
  if (!exists) {
    await db.createCollection(
      name,
      validator ? { validator, validationLevel: "strict", validationAction: "error" } : {},
    );
    return;
  }
  if (validator) {
    await db.command({
      collMod: name,
      validator,
      validationLevel: "strict",
      validationAction: "error",
    });
  }
}

export async function ensure(db) {
  await ensureCollection(db, "entities");
  await ensureCollection(db, "disputes");
  await ensureCollection(db, "ledger");
  await ensureCollection(db, "memories");
  await ensureCollection(db, "sessions");
  await ensureCollection(db, "runs");
  await ensureCollection(db, "actors");
  await ensureCollection(db, "audit", auditValidator);

  await db.collection("ledger").createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection("disputes").createIndex({ tenantId: 1, status: 1 });
  await db.collection("memories").createIndex({ tenantId: 1, forgotten: 1 });
  await db.collection("memories").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("audit").createIndex({ runId: 1, at: 1 });
  await db.collection("runs").createIndex({ tenantId: 1, disputeId: 1 });
  await db.collection("entities").createIndex({ tenantId: 1, type: 1 });
}

/**
 * Vector index is optional at runtime. Recall falls back to cosine over the
 * tenant's memories when the index is missing or still building.
 */
export async function ensureVectorIndex(db, dimensions) {
  const memories = db.collection("memories");
  try {
    const indexes = await memories.listSearchIndexes("memory_vector").toArray();
    const existing = indexes[0];
    const existingDimensions = existing?.latestDefinition?.fields?.find((field) => field.type === "vector")?.numDimensions;
    if (existing && existingDimensions === dimensions) return existing.queryable === true;
    if (existing && existingDimensions !== dimensions) {
      await memories.dropSearchIndex("memory_vector");
    }
    await memories.createSearchIndex({
      name: "memory_vector",
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
          { type: "filter", path: "tenantId" },
          { type: "filter", path: "forgotten" },
          { type: "filter", path: "embedder" },
        ],
      },
    });
  } catch {
    return false;
  }
  return false;
}
