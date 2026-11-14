import assert from "node:assert/strict";
import test from "node:test";
import {
  earningsReleaseAllowed,
  legsBalance,
  planResolution,
  splitCancellationFeeCents,
  summarizeTripLedger,
} from "./policy.js";

const agent = {
  _id: "agent:dispute-resolver",
  name: "Dispute resolver",
  capabilities: ["dispute.investigate", "dispute.resolve"],
};
const operator = {
  _id: "ops:amina",
  name: "Amina Cole",
  capabilities: ["dispute.investigate", "dispute.resolve", "dispute.resolve.elevated", "dispute.rollback"],
};

const routeMemory = {
  _id: "mem-route-15",
  ruleId: "route-deviation-15",
  text: "Dismiss route deviations under 15% without photos.",
};

test("cancellation fee splits 80/20 in cents", () => {
  assert.deepEqual(splitCancellationFeeCents(800), { driverCents: 640, platformCents: 160 });
});

test("open disputes block earnings release", () => {
  assert.equal(earningsReleaseAllowed("OPEN"), false);
  assert.equal(earningsReleaseAllowed("UNDER_REVIEW"), false);
  assert.equal(earningsReleaseAllowed("DISMISSED"), true);
  assert.equal(earningsReleaseAllowed("RESOLVED"), true);
});

test("never-arrived cancellation fee reverses under the auto cap", () => {
  const decision = planResolution({
    actor: agent,
    dispute: {
      _id: "dispute:dsp-cancel",
      tripId: "trip:t-cancel",
      raisedById: "rider:leila",
      status: "OPEN",
      reason: "Driver never arrived and I was charged a cancellation fee",
    },
    trip: {
      _id: "trip:t-cancel",
      status: "CANCELLED",
      tripKind: "RIDE",
      riderId: "rider:leila",
      driverId: "driver:jonas",
    },
    ledger: [
      {
        tripId: "trip:t-cancel",
        type: "CANCELLATION_FEE",
        status: "POSTED",
        amountCad: 8,
        legs: [
          { kind: "PROVIDER_PENDING", ownerUserId: "driver:jonas", direction: "CREDIT", amountCad: 6.4 },
          { kind: "PLATFORM_COMMISSION", direction: "CREDIT", amountCad: 1.6 },
        ],
      },
    ],
    memories: [],
  });

  assert.equal(decision.action, "RESOLVE_REFUND");
  assert.equal(decision.refundCad, 8);
  assert.equal(decision.idempotencyKey, "cancel-fee-reversal:trip:t-cancel");
  assert.equal(decision.policy.allow, true);
  assert.equal(legsBalance(decision.legs), true);
});

test("route memory dismisses a small deviation and records the counterfactual", () => {
  const decision = planResolution({
    actor: agent,
    dispute: {
      _id: "dispute:dsp-route",
      tripId: "trip:t-route",
      raisedById: "rider:marco",
      status: "OPEN",
      reason: "Driver took a longer route. Expected 10 km and we drove 10.8 km.",
      evidencePhotoCount: 0,
    },
    trip: {
      _id: "trip:t-route",
      status: "COMPLETED",
      tripKind: "RIDE",
      riderId: "rider:marco",
      driverId: "driver:sam",
      finalFareCad: 42,
      expectedDistanceKm: 10,
      actualDistanceKm: 10.8,
    },
    ledger: [
      {
        tripId: "trip:t-route",
        type: "RIDE_PAYMENT",
        status: "POSTED",
        amountCad: 42,
        legs: [{ kind: "PROVIDER_PENDING", ownerUserId: "driver:sam", direction: "CREDIT", amountCad: 33.6 }],
      },
    ],
    memories: [routeMemory],
  });

  assert.equal(decision.action, "DISMISS");
  assert.equal(decision.refundCad, 0);
  assert.equal(decision.memoriesUsed[0].id, "mem-route-15");
  assert.equal(decision.counterfactual.refundCad, 3.36);
  assert.equal(decision.policy.allow, true);
});

test("the same route complaint refunds the extra share when the memory is absent", () => {
  const decision = planResolution({
    actor: agent,
    dispute: {
      _id: "dispute:dsp-route",
      tripId: "trip:t-route",
      raisedById: "rider:marco",
      status: "OPEN",
      reason: "Driver took a longer route. Expected 10 km and we drove 10.8 km.",
      evidencePhotoCount: 0,
    },
    trip: {
      _id: "trip:t-route",
      status: "COMPLETED",
      tripKind: "RIDE",
      riderId: "rider:marco",
      driverId: "driver:sam",
      finalFareCad: 42,
      expectedDistanceKm: 10,
      actualDistanceKm: 10.8,
    },
    ledger: [],
    memories: [],
  });

  assert.equal(decision.action, "RESOLVE_REFUND");
  assert.equal(decision.refundCad, 3.36);
  assert.deepEqual(decision.memoriesUsed, []);
});

test("a duplicate charge above the cap waits for an elevated operator", () => {
  const shared = {
    dispute: {
      _id: "dispute:dsp-over",
      tripId: "trip:t-over",
      raisedById: "rider:priya",
      status: "OPEN",
      reason: "I was charged twice for the same trip",
    },
    trip: {
      _id: "trip:t-over",
      status: "COMPLETED",
      tripKind: "RIDE",
      riderId: "rider:priya",
      driverId: "driver:jonas",
      finalFareCad: 86,
    },
    ledger: [
      {
        tripId: "trip:t-over",
        type: "RIDE_PAYMENT",
        status: "POSTED",
        amountCad: 86,
        legs: [{ kind: "PROVIDER_PENDING", direction: "CREDIT", amountCad: 68.8 }],
      },
      {
        tripId: "trip:t-over",
        type: "RIDE_PAYMENT",
        status: "POSTED",
        amountCad: 86,
        legs: [{ kind: "PROVIDER_PENDING", direction: "CREDIT", amountCad: 68.8 }],
      },
    ],
    memories: [],
  };

  const blocked = planResolution({ ...shared, actor: agent });
  assert.equal(blocked.action, "AWAIT_AUTHORITY");
  assert.equal(blocked.policy.allow, false);
  assert.equal(blocked.refundCad, 86);

  const allowed = planResolution({ ...shared, actor: operator });
  assert.equal(allowed.action, "RESOLVE_REFUND");
  assert.equal(allowed.policy.allow, true);
  assert.equal(allowed.clawbackCad, 86);
  assert.equal(legsBalance(allowed.legs), true);
});

test("a stranger and a closed dispute cannot post a reversal", () => {
  const stranger = planResolution({
    actor: agent,
    dispute: {
      _id: "dispute:x",
      raisedById: "rider:leila",
      status: "OPEN",
      reason: "charged twice",
    },
    trip: { _id: "trip:x", status: "COMPLETED", tripKind: "RIDE", riderId: "rider:other", driverId: "driver:jonas" },
    ledger: [],
    memories: [],
  });
  assert.equal(stranger.action, "DENY");

  const closed = planResolution({
    actor: operator,
    dispute: {
      _id: "dispute:x",
      raisedById: "rider:leila",
      status: "RESOLVED",
      reason: "charged twice",
      tripId: "trip:x",
    },
    trip: { _id: "trip:x", status: "COMPLETED", tripKind: "RIDE", riderId: "rider:leila", driverId: "driver:jonas" },
    ledger: [],
    memories: [],
  });
  assert.equal(closed.action, "NOOP");
});

test("ledger summary nets a reversal against the captured fee", () => {
  const summary = summarizeTripLedger(
    [
      { tripId: "trip:t", type: "CANCELLATION_FEE", status: "POSTED", amountCad: 8, legs: [] },
      { tripId: "trip:t", type: "CANCELLATION_FEE_REVERSAL", status: "POSTED", amountCad: 8, legs: [] },
    ],
    "trip:t",
  );
  assert.equal(summary.capturedFeeCents, 0);
});
