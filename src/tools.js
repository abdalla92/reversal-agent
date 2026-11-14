import { randomUUID } from "node:crypto";
import { embed, rankByEmbedding } from "./embeddings.js";
import {
  earningsReleaseAllowed,
  legsBalance,
  perceive,
  planResolution,
} from "./policy.js";

function readerRole(actor) {
  return actor?.kind === "operator" ? "ops" : "agent";
}

function asTrip(entity) {
  if (!entity) return null;
  return { _id: entity._id, ...entity.attributes };
}

function withoutEmbedding(doc) {
  if (!doc) return doc;
  const { embedding, ...rest } = doc;
  return rest;
}

async function audit(db, event) {
  await db.collection("audit").insertOne({ ...event, at: new Date() });
}

export async function loadActor(db, actorId, tenantId) {
  const actor = await db.collection("actors").findOne({ _id: actorId, tenantId });
  if (!actor) {
    throw new Error(`No actor ${actorId} in tenant ${tenantId}.`);
  }
  return actor;
}

export async function loadCase(db, { tenantId, disputeId, text }) {
  let dispute = null;
  if (disputeId) {
    dispute = await db.collection("disputes").findOne({ _id: disputeId, tenantId, historical: { $ne: true } });
  }
  if (!dispute && text) {
    const tokens = text
      .toLowerCase()
      .split(/\W+/)
      .filter((token) => token.length > 3)
      .slice(0, 4);
    const pattern = tokens.join("|");
    dispute = pattern
      ? await db.collection("disputes").findOne({
          tenantId,
          historical: { $ne: true },
          status: { $in: ["OPEN", "UNDER_REVIEW"] },
          reason: { $regex: pattern, $options: "i" },
        })
      : null;
  }
  if (!dispute) {
    return { found: false, reason: "No open dispute matched this complaint." };
  }
  const trip = asTrip(await db.collection("entities").findOne({ _id: dispute.tripId, tenantId }));
  return { found: true, dispute: withoutEmbedding(dispute), trip };
}

export async function graphLookup(db, { tenantId, disputeId }) {
  const pipeline = [
    { $match: { _id: disputeId, tenantId } },
    {
      $graphLookup: {
        from: "entities",
        startWith: "$relationships",
        connectFromField: "relationships",
        connectToField: "_id",
        as: "connected",
        maxDepth: 3,
        depthField: "distance",
        restrictSearchWithMatch: { tenantId },
      },
    },
    {
      $project: {
        _id: 1,
        type: 1,
        label: 1,
        attributes: 1,
        relationships: 1,
        "connected._id": 1,
        "connected.type": 1,
        "connected.label": 1,
        "connected.distance": 1,
        "connected.attributes.status": 1,
      },
    },
  ];
  const [start] = await db.collection("entities").aggregate(pipeline).toArray();
  if (!start) return { found: false, connected: [] };
  const connected = start.connected || [];
  return {
    found: true,
    startId: start._id,
    connected,
    reachedTrip: connected.some((node) => node._id === start.attributes?.tripId || node.type === "trip"),
  };
}

export async function recallMemories(db, { tenantId, actor, query, disputeId }) {
  const role = readerRole(actor);
  const { embedding, embedder } = await embed(query, "query");
  const now = new Date();
  const visible = {
    tenantId,
    forgotten: { $ne: true },
    readers: role,
    embedder,
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }],
  };

  let source = "cosine-fallback";
  let memories = [];
  try {
    // The vector index lags the write that sets forgotten=true. Candidates are
    // ranked here, then accepted only if the collection still says they are visible.
    const searched = await db
      .collection("memories")
      .aggregate([
        {
          $vectorSearch: {
            index: "memory_vector",
            path: "embedding",
            queryVector: embedding,
            numCandidates: 40,
            limit: 8,
            filter: { tenantId, forgotten: false, embedder },
          },
        },
      ])
      .toArray();
    if (searched.length > 0) {
      const order = new Map(searched.map((doc, index) => [String(doc._id), index]));
      const fresh = await db
        .collection("memories")
        .find({ _id: { $in: searched.map((doc) => doc._id) }, ...visible })
        .toArray();
      fresh.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
      if (fresh.length > 0) {
        source = "vectorSearch";
        memories = fresh.slice(0, 4).map((doc) => ({ ...withoutEmbedding(doc), score: doc.score }));
      }
    }
  } catch {
    source = "cosine-fallback";
  }

  if (source !== "vectorSearch") {
    const docs = await db.collection("memories").find(visible).toArray();
    memories = rankByEmbedding(docs, embedding, 4).map(({ doc, score }) => ({
      ...withoutEmbedding(doc),
      score,
    }));
  }

  const closed = await db
    .collection("disputes")
    .find({
      tenantId,
      embedder,
      status: { $in: ["RESOLVED", "DISMISSED"] },
      _id: { $ne: disputeId },
    })
    .toArray();
  const similarCases = rankByEmbedding(closed, embedding, 2).map(({ doc, score }) => ({
    _id: doc._id,
    status: doc.status,
    reason: doc.reason,
    resolution: doc.resolution,
    score,
  }));

  const withheld = await db.collection("memories").countDocuments({
    $or: [
      { tenantId: { $ne: tenantId }, readers: role },
      { tenantId, readers: { $ne: role }, forgotten: { $ne: true } },
      { tenantId, forgotten: true },
    ],
  });

  return { source, memories, similarCases, withheld };
}

export async function inspectLedger(db, { tenantId, tripId }) {
  const entries = await db.collection("ledger").find({ tenantId, tripId }).sort({ _id: 1 }).toArray();
  return {
    tripId,
    entries: entries.map((entry) => ({
      _id: entry._id,
      type: entry.type,
      status: entry.status,
      amountCad: entry.amountCad,
      idempotencyKey: entry.idempotencyKey,
      legs: entry.legs,
    })),
  };
}

export async function checkPolicy(db, { tenantId, actor, disputeId, memories, perceptionText, graph }) {
  const loaded = await loadCase(db, { tenantId, disputeId });
  if (!loaded.found) {
    return { plan: { action: "DENY", policy: { allow: false, reason: loaded.reason }, legs: [], memoriesUsed: [] } };
  }
  const reached = graph?.connected?.some((node) => node._id === loaded.dispute.tripId);
  if (!reached) {
    return {
      plan: {
        action: "DENY",
        refundCad: 0,
        legs: [],
        memoriesUsed: [],
        counterfactual: null,
        policy: { allow: false, reason: "Graph walk did not reach the trip. Refusing to decide from the complaint text alone." },
        thought: "The dispute node is not connected to its trip, so the ledger cannot be trusted yet.",
      },
    };
  }
  const ledger = await db.collection("ledger").find({ tenantId, tripId: loaded.dispute.tripId }).toArray();
  const plan = planResolution({
    actor,
    dispute: loaded.dispute,
    trip: loaded.trip,
    ledger,
    memories,
    perception: perceive(perceptionText || loaded.dispute.reason),
  });
  return { plan };
}

export async function commitResolution(db, { tenantId, actor, runId, disputeId, memories, perceptionText, graph }) {
  const checked = await checkPolicy(db, { tenantId, actor, disputeId, memories, perceptionText, graph });
  const plan = checked.plan;

  if (plan.action === "NOOP") {
    const current = await db.collection("disputes").findOne({ _id: disputeId, tenantId });
    await audit(db, {
      tenantId,
      runId,
      actorId: actor._id,
      tool: "commit_resolution",
      outcome: "idempotent",
      policy: plan.policy,
      args: { disputeId },
    });
    return { committed: true, idempotent: true, disputeStatus: current?.status || "RESOLVED", plan };
  }

  if (!plan.policy?.allow || (plan.action !== "RESOLVE_REFUND" && plan.action !== "DISMISS")) {
    await audit(db, {
      tenantId,
      runId,
      actorId: actor._id,
      tool: "commit_resolution",
      outcome: "denied",
      policy: plan.policy,
      args: { disputeId, action: plan.action },
    });
    return { committed: false, disputeStatus: null, plan };
  }

  const status = plan.action === "DISMISS" ? "DISMISSED" : "RESOLVED";
  let idempotent = false;

  if (plan.action === "RESOLVE_REFUND") {
    if (!legsBalance(plan.legs)) {
      await audit(db, {
        tenantId,
        runId,
        actorId: actor._id,
        tool: "commit_resolution",
        outcome: "denied",
        policy: { allow: false, reason: "Reversal legs do not balance, so nothing was posted." },
        args: { disputeId },
      });
      return { committed: false, disputeStatus: null, plan };
    }
    const existing = await db.collection("ledger").findOne({ idempotencyKey: plan.idempotencyKey });
    if (!existing) {
      try {
        await db.collection("ledger").insertOne({
          _id: `ledger:${plan.idempotencyKey}`,
          tenantId,
          tripId: (await loadCase(db, { tenantId, disputeId })).dispute.tripId,
          disputeId,
          type: plan.reversalKind,
          status: "POSTED",
          amountCad: plan.refundCad,
          idempotencyKey: plan.idempotencyKey,
          postedBy: actor._id,
          legs: plan.legs,
          createdAt: new Date(),
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        idempotent = true;
      }
    } else {
      idempotent = true;
    }
  }

  await db.collection("disputes").updateOne(
    { _id: disputeId, tenantId },
    {
      $set: {
        status,
        resolution: plan.thought,
        refundAmount: plan.refundCad,
        resolvedById: actor._id,
        updatedAt: new Date(),
      },
    },
  );
  await db.collection("entities").updateOne(
    { _id: disputeId, tenantId },
    { $set: { "attributes.status": status } },
  );

  await audit(db, {
    tenantId,
    runId,
    actorId: actor._id,
    tool: "commit_resolution",
    outcome: idempotent ? "idempotent" : "allowed",
    policy: plan.policy,
    args: {
      disputeId,
      action: plan.action,
      refundCad: plan.refundCad,
      idempotencyKey: plan.idempotencyKey,
      memoriesUsed: (plan.memoriesUsed || []).map((memory) => memory.id),
    },
  });

  return { committed: true, idempotent, disputeStatus: status, plan };
}

export async function suspendForAuthority(db, { tenantId, actor, runId, disputeId, plan }) {
  await db.collection("disputes").updateOne(
    { _id: disputeId, tenantId, status: "OPEN" },
    { $set: { status: "UNDER_REVIEW", updatedAt: new Date() } },
  );
  await db.collection("entities").updateOne(
    { _id: disputeId, tenantId },
    { $set: { "attributes.status": "UNDER_REVIEW" } },
  );
  await audit(db, {
    tenantId,
    runId,
    actorId: actor._id,
    tool: "suspend_for_authority",
    outcome: "allowed",
    policy: plan?.policy || { allow: false, reason: "Waiting for an elevated actor." },
    args: { disputeId, refundCad: plan?.refundCad ?? null },
  });
  return { awaiting: true, disputeStatus: "UNDER_REVIEW", plan };
}

export async function checkEarningsHold(db, { tenantId, disputeId }) {
  const dispute = await db.collection("disputes").findOne({ _id: disputeId, tenantId });
  const allowed = earningsReleaseAllowed(dispute?.status);
  return {
    disputeStatus: dispute?.status,
    releaseAllowed: allowed,
    reason: allowed
      ? "No open dispute remains on this trip, so provider earnings may leave the reserve."
      : "Earnings stay in PROVIDER_PENDING while this dispute is open or under review.",
  };
}

export async function forgetMemory(db, { tenantId, actor, runId, memoryId }) {
  const caps = new Set(actor.capabilities || []);
  if (!caps.has("dispute.resolve.elevated") && !caps.has("dispute.rollback")) {
    await audit(db, {
      tenantId,
      runId: runId || `forget-${randomUUID()}`,
      actorId: actor._id,
      tool: "forget_memory",
      outcome: "denied",
      policy: { allow: false, reason: "Only an elevated operator can forget a memory." },
      args: { memoryId },
    });
    return { forgotten: false };
  }
  const result = await db.collection("memories").updateOne(
    { _id: memoryId, tenantId },
    { $set: { forgotten: true, forgottenBy: actor._id, forgottenAt: new Date() } },
  );
  await audit(db, {
    tenantId,
    runId: runId || `forget-${randomUUID()}`,
    actorId: actor._id,
    tool: "forget_memory",
    outcome: result.modifiedCount ? "allowed" : "idempotent",
    policy: { allow: true, reason: "Memory hidden from later retrieval. The document stays for audit." },
    args: { memoryId },
  });
  return { forgotten: true, modified: result.modifiedCount > 0 };
}

export async function rollbackReversal(db, { tenantId, actor, disputeId }) {
  const caps = new Set(actor.capabilities || []);
  const runId = `rollback-${disputeId}`;
  if (!caps.has("dispute.rollback")) {
    await audit(db, {
      tenantId,
      runId,
      actorId: actor._id,
      tool: "rollback_reversal",
      outcome: "denied",
      policy: { allow: false, reason: "Rollback requires dispute.rollback." },
      args: { disputeId },
    });
    return { rolledBack: false };
  }

  const dispute = await db.collection("disputes").findOne({ _id: disputeId, tenantId });
  const original = await db.collection("ledger").findOne({
    tenantId,
    disputeId,
    status: "POSTED",
    type: { $in: ["CANCELLATION_FEE_REVERSAL", "EARNINGS_CLAWBACK"] },
  });
  if (!original) {
    await audit(db, {
      tenantId,
      runId,
      actorId: actor._id,
      tool: "rollback_reversal",
      outcome: "denied",
      policy: { allow: false, reason: "No posted reversal to roll back." },
      args: { disputeId },
    });
    return { rolledBack: false };
  }

  const rollbackKey = `rollback:${original.idempotencyKey}`;
  const existing = await db.collection("ledger").findOne({ idempotencyKey: rollbackKey });
  if (!existing) {
    await db.collection("ledger").insertOne({
      _id: `ledger:${rollbackKey}`,
      tenantId,
      tripId: original.tripId,
      disputeId,
      type: `${original.type}_ROLLBACK`,
      status: "POSTED",
      amountCad: original.amountCad,
      idempotencyKey: rollbackKey,
      postedBy: actor._id,
      compensates: original.idempotencyKey,
      legs: (original.legs || []).map((leg) => ({
        ...leg,
        direction: leg.direction === "DEBIT" ? "CREDIT" : "DEBIT",
      })),
      createdAt: new Date(),
    });
  }

  await db.collection("disputes").updateOne(
    { _id: disputeId, tenantId },
    {
      $set: {
        status: "UNDER_REVIEW",
        resolution: `Rolled back ${original.idempotencyKey} by ${actor._id}.`,
        refundAmount: null,
        resolvedById: null,
        updatedAt: new Date(),
      },
    },
  );

  await audit(db, {
    tenantId,
    runId,
    actorId: actor._id,
    tool: "rollback_reversal",
    outcome: existing ? "idempotent" : "allowed",
    policy: { allow: true, reason: "Compensating ledger entry posted. The original reversal row was not edited." },
    args: { disputeId, compensates: original.idempotencyKey },
  });

  return { rolledBack: true, idempotent: Boolean(existing), disputeStatus: dispute?.status, compensates: original.idempotencyKey };
}

export async function appendSession(db, { sessionId, tenantId, actorId, role, content }) {
  await db.collection("sessions").updateOne(
    { _id: sessionId },
    {
      $setOnInsert: { tenantId, actorId, createdAt: new Date() },
      $push: { interactions: { role, content, at: new Date() } },
    },
    { upsert: true },
  );
}

export async function readSession(db, sessionId) {
  return db.collection("sessions").findOne({ _id: sessionId });
}
