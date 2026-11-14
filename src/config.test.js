import assert from "node:assert/strict";
import test from "node:test";
import ConnectionString from "mongodb-connection-string-url";
import { normalizeMongoUri } from "./config.js";

test("a password that contains @ is encoded so the driver keeps the real host", () => {
  const raw = "mongodb+srv://rider:secret@92@cluster0.example.mongodb.net/?retryWrites=true&w=majority";
  const normalized = normalizeMongoUri(raw);
  const parsed = new ConnectionString(normalized);
  assert.equal(parsed.hosts[0], "cluster0.example.mongodb.net");
  assert.equal(decodeURIComponent(parsed.password), "secret@92");
  assert.equal(new ConnectionString(raw).hosts[0], "92");
});
