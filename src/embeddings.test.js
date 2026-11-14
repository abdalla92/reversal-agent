import assert from "node:assert/strict";
import test from "node:test";
import { localEmbedding, rankByEmbedding } from "./embeddings.js";

test("a route complaint ranks the route memory ahead of an unrelated note", () => {
  const route = localEmbedding(
    "Longer route deviations under 15% of the expected distance in km are dismissed unless the rider attached photo evidence.",
  );
  const fee = localEmbedding("A cancellation fee is reversed in full when the driver never arrived.");
  const ranked = rankByEmbedding(
    [
      { _id: "fee", embedding: fee },
      { _id: "route", embedding: route },
    ],
    localEmbedding("Driver took a longer route. Expected 10 km and we drove 10.8 km."),
  );
  assert.equal(ranked[0].doc._id, "route");
  assert.ok(ranked[0].score > ranked[1].score);
});
