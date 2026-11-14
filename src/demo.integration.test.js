import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { runDemo } from "./demo.js";

test("dispute agent demo against an in-memory MongoDB", { timeout: 180_000 }, async () => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  try {
    await client.connect();
    const result = await runDemo(client.db("reversal_agent"));
    assert.equal(result.route, "COMPLETED");
    assert.equal(result.waiting, "AWAITING_AUTHORITY");
    assert.equal(result.posted, "COMPLETED");
    assert.equal(result.resumed, "COMPLETED");
    assert.ok(result.audit > 0);
  } finally {
    await client.close();
    await server.stop();
  }
});
