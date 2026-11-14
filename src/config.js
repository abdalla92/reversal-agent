import dotenv from "dotenv";

dotenv.config();

export const DB_NAME = process.env.MONGODB_DB || "reversal_agent";

/**
 * One Node process, a single operator, short dispute lookups.
 * Cluster0 is an M10 with a 3-member replica set (MongoDB 8/9).
 * Each connection costs about 1 MB on the server, and each client also opens
 * 2 monitoring connections per member:
 *   1 process × (maxPoolSize + 2) × 3 members = 36 connections.
 * minPoolSize 0 because the demo is bursty and should not hold idle connections.
 */
export const mongoOptions = {
  appName: "reversal-agent",
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 30_000,
};

/**
 * Percent-encode the username and password. The driver stops the password at the
 * first raw "@", so a password that contains "@" is read as the host name.
 */
export function normalizeMongoUri(uri) {
  const trimmed = String(uri).trim().replace(/^['"]|['"]$/g, "");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("MONGODB_URI is not a valid connection string.");
  }
  if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:") {
    throw new Error("MONGODB_URI must start with mongodb:// or mongodb+srv://.");
  }
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return trimmed;
  const username = encodeURIComponent(decodeURIComponent(parsed.username));
  const password = encodeURIComponent(decodeURIComponent(parsed.password));
  const userinfo = parsed.password ? `${username}:${password}` : username;
  return `${parsed.protocol}//${userinfo}@${trimmed.slice(at + 1)}`;
}

export function requireMongoUri() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Copy .env.example to .env and paste the Atlas sandbox connection string.",
    );
  }
  return normalizeMongoUri(uri);
}
