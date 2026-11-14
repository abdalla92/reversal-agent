/**
 * Decision rules mirrored from the GOTIA dispute route and wallet ledger.
 * Cancellation-fee reversals split 80/20 (driver / platform) and mirror the
 * capture. Completed-trip refunds claw provider earnings back, capped at what
 * the provider earned; any remainder is the platform's to absorb.
 * Money movement at or under AUTO_RESOLVE_MAX_CAD can be committed by an actor
 * with dispute.resolve. Above that cap the run waits for dispute.resolve.elevated.
 */

export const AUTO_RESOLVE_MAX_CAD = 25;
export const DRIVER_SHARE = 0.8;
export const ROUTE_DEVIATION_DISMISS_RATIO = 0.15;

export function toCents(cad) {
  return Math.round(Number(cad) * 100);
}

export function fromCents(cents) {
  return Math.round(cents) / 100;
}

export function splitCancellationFeeCents(feeCents) {
  const driverCents = Math.round(feeCents * DRIVER_SHARE);
  const platformCents = feeCents - driverCents;
  return { driverCents, platformCents };
}

export function earningsReleaseAllowed(disputeStatus) {
  return disputeStatus !== "OPEN" && disputeStatus !== "UNDER_REVIEW";
}

export function perceive(text) {
  const normalized = String(text || "").toLowerCase();
  return {
    text: String(text || ""),
    claimsCancellationFee: /cancel|never arrived|no[- ]show|did not arrive|didn't arrive/.test(normalized),
    claimsRoute: /route|detour|longer|distance|\bkm\b/.test(normalized),
    claimsDuplicate: /twice|duplicate|double charged|charged twice|two charges/.test(normalized),
  };
}

export function summarizeTripLedger(entries, tripId) {
  const posted = (entries || []).filter((entry) => entry.tripId === tripId && entry.status === "POSTED");
  let pending = 0;
  let payable = 0;
  let capturedFee = 0;
  let reversedFee = 0;
  const ridePayments = [];

  for (const entry of posted) {
    if (entry.type === "CANCELLATION_FEE" || entry.type === "CANCELLATION_FEE_REVERSAL_ROLLBACK") {
      capturedFee += toCents(entry.amountCad);
    }
    if (entry.type === "CANCELLATION_FEE_REVERSAL") reversedFee += toCents(entry.amountCad);
    if (entry.type === "RIDE_PAYMENT") ridePayments.push(entry);
    for (const leg of entry.legs || []) {
      const cents = toCents(leg.amountCad);
      const signed = leg.direction === "CREDIT" ? cents : -cents;
      if (leg.kind === "PROVIDER_PENDING") pending += signed;
      if (leg.kind === "PROVIDER_PAYABLE") payable += signed;
    }
  }

  return {
    pendingCents: pending,
    payableCents: payable,
    earningsCents: Math.max(0, pending) + Math.max(0, payable),
    capturedFeeCents: Math.max(0, capturedFee - reversedFee),
    ridePayments,
  };
}

function emptyDecision(action, reason, extra = {}) {
  return {
    action,
    refundCad: 0,
    clawbackCad: 0,
    reversalKind: null,
    idempotencyKey: null,
    legs: [],
    memoriesUsed: [],
    counterfactual: null,
    thought: reason,
    policy: { allow: action !== "DENY" && action !== "AWAIT_AUTHORITY", reason },
    ...extra,
  };
}

function balanced(legs) {
  const debit = legs.filter((leg) => leg.direction === "DEBIT").reduce((sum, leg) => sum + toCents(leg.amountCad), 0);
  const credit = legs.filter((leg) => leg.direction === "CREDIT").reduce((sum, leg) => sum + toCents(leg.amountCad), 0);
  return debit === credit && debit > 0;
}

function clawbackLegs({ driverId, riderId, refundCents, pendingCents, payableCents }) {
  let remaining = refundCents;
  const legs = [];
  const fromPending = Math.min(Math.max(0, pendingCents), remaining);
  remaining -= fromPending;
  const fromPayable = Math.min(Math.max(0, payableCents), remaining);
  remaining -= fromPayable;
  if (fromPending > 0) {
    legs.push({ kind: "PROVIDER_PENDING", ownerUserId: driverId, direction: "DEBIT", amountCad: fromCents(fromPending) });
  }
  if (fromPayable > 0) {
    legs.push({ kind: "PROVIDER_PAYABLE", ownerUserId: driverId, direction: "DEBIT", amountCad: fromCents(fromPayable) });
  }
  if (remaining > 0) {
    legs.push({ kind: "PLATFORM_COMMISSION", direction: "DEBIT", amountCad: fromCents(remaining) });
  }
  legs.push({ kind: "RIDER_WALLET", ownerUserId: riderId, direction: "CREDIT", amountCad: fromCents(refundCents) });
  return {
    legs,
    clawbackCents: fromPending + fromPayable,
  };
}

function feeReversalLegs({ driverId, riderId, feeCents }) {
  const { driverCents, platformCents } = splitCancellationFeeCents(feeCents);
  const legs = [];
  if (driverId && driverCents > 0) {
    legs.push({ kind: "PROVIDER_PENDING", ownerUserId: driverId, direction: "DEBIT", amountCad: fromCents(driverCents) });
  }
  if (platformCents > 0) {
    legs.push({ kind: "PLATFORM_COMMISSION", direction: "DEBIT", amountCad: fromCents(platformCents) });
  }
  if (!driverId && driverCents > 0) {
    legs.push({ kind: "PLATFORM_COMMISSION", direction: "DEBIT", amountCad: fromCents(driverCents) });
  }
  legs.push({ kind: "RIDER_WALLET", ownerUserId: riderId, direction: "CREDIT", amountCad: fromCents(feeCents) });
  return legs;
}

function withAuthority(decision, actor) {
  const caps = new Set(actor?.capabilities || []);
  const canResolve = caps.has("dispute.resolve") || caps.has("dispute.resolve.elevated");
  const elevated = caps.has("dispute.resolve.elevated");
  if (!canResolve) {
    return emptyDecision("DENY", `${actor?.name || actor?._id || "This actor"} is not allowed to resolve disputes.`);
  }
  const overCap = toCents(decision.refundCad) > toCents(AUTO_RESOLVE_MAX_CAD);
  if (overCap && !elevated) {
    return {
      ...decision,
      action: "AWAIT_AUTHORITY",
      policy: {
        allow: false,
        reason: `Refund of ${decision.refundCad.toFixed(2)} CAD is above the ${AUTO_RESOLVE_MAX_CAD} CAD auto-resolve cap. Waiting for an actor with dispute.resolve.elevated.`,
      },
    };
  }
  return {
    ...decision,
    policy: { allow: true, reason: decision.policy.reason },
  };
}

/**
 * @param {{ actor: object, dispute: object, trip: object, ledger: object[], memories: object[], perception?: object }} input
 */
export function planResolution(input) {
  const { actor, dispute, trip, ledger, memories = [] } = input;
  const perception = input.perception || perceive(dispute?.reason || "");

  if (!dispute || !trip) {
    return emptyDecision("DENY", "The dispute or its trip is missing, so no reversal can be posted.");
  }
  if (dispute.status === "RESOLVED" || dispute.status === "DISMISSED") {
    return emptyDecision("NOOP", "The dispute is already closed. A resumed run must not post a second reversal.", {
      policy: { allow: true, reason: "Already closed." },
    });
  }

  const participant = dispute.raisedById === trip.riderId || dispute.raisedById === trip.driverId;
  if (!participant) {
    return emptyDecision("DENY", "Only a rider or driver on the trip can open this dispute.");
  }
  if (trip.tripKind === "HAUL" && !dispute.reasonCategory) {
    return emptyDecision(
      "AWAIT_AUTHORITY",
      "Haul disputes need a reason category before a reversal. The run stops here and waits for that field.",
    );
  }

  const books = summarizeTripLedger(ledger, trip._id || dispute.tripId);
  const routeMemory = memories.find((memory) => memory.ruleId === "route-deviation-15");

  if (trip.status === "CANCELLED" && books.capturedFeeCents > 0 && perception.claimsCancellationFee) {
    const feeCents = books.capturedFeeCents;
    const legs = feeReversalLegs({
      driverId: trip.driverId,
      riderId: trip.riderId,
      feeCents,
    });
    return withAuthority(
      {
        action: "RESOLVE_REFUND",
        refundCad: fromCents(feeCents),
        clawbackCad: fromCents(splitCancellationFeeCents(feeCents).driverCents),
        reversalKind: "CANCELLATION_FEE_REVERSAL",
        idempotencyKey: `cancel-fee-reversal:${trip._id}`,
        legs,
        memoriesUsed: [],
        counterfactual: null,
        thought: `Cancelled trip still has a captured fee of ${fromCents(feeCents).toFixed(2)} CAD. Mirror the capture: driver 80%, platform 20%, rider credited the full fee.`,
        policy: {
          allow: true,
          reason: "Cancellation-fee reversal is capped at the captured fee and uses the platform idempotency key.",
        },
      },
      actor,
    );
  }

  if (perception.claimsDuplicate && books.ridePayments.length >= 2) {
    const extraCents = books.ridePayments.slice(1).reduce((sum, entry) => sum + toCents(entry.amountCad), 0);
    const { legs, clawbackCents } = clawbackLegs({
      driverId: trip.driverId,
      riderId: trip.riderId,
      refundCents: extraCents,
      pendingCents: books.pendingCents,
      payableCents: books.payableCents,
    });
    return withAuthority(
      {
        action: "RESOLVE_REFUND",
        refundCad: fromCents(extraCents),
        clawbackCad: fromCents(clawbackCents),
        reversalKind: "EARNINGS_CLAWBACK",
        idempotencyKey: `clawback:dispute:${dispute._id}`,
        legs,
        memoriesUsed: [],
        counterfactual: null,
        thought: `Ledger shows ${books.ridePayments.length} ride payments. Refund the duplicate ${fromCents(extraCents).toFixed(2)} CAD and claw back only what the provider still holds.`,
        policy: {
          allow: true,
          reason: "Duplicate ride payments are refunded for the extra capture only. Clawback cannot exceed provider earnings.",
        },
      },
      actor,
    );
  }

  const ratio = deviationRatio(trip);
  if (perception.claimsRoute && ratio != null && ratio > 0) {
    const fareCents = toCents(trip.finalFareCad || 0);
    const extraCents = Math.round(fareCents * ratio);
    const dismissed = Boolean(routeMemory) && ratio < ROUTE_DEVIATION_DISMISS_RATIO && (dispute.evidencePhotoCount || 0) === 0;
    const counterfactual = {
      action: "RESOLVE_REFUND",
      refundCad: fromCents(extraCents),
      reason: "Without the route-deviation memory, the extra-distance share of the fare would be refunded.",
    };

    if (dismissed) {
      return withAuthority(
        {
          action: "DISMISS",
          refundCad: 0,
          clawbackCad: 0,
          reversalKind: null,
          idempotencyKey: null,
          legs: [],
          memoriesUsed: [{ id: routeMemory._id, text: routeMemory.text }],
          counterfactual,
          thought: `Distance ran ${(ratio * 100).toFixed(1)}% long, under 15%, and there is no photo. Memory ${routeMemory._id} dismisses the dispute. Without that memory the refund would be ${fromCents(extraCents).toFixed(2)} CAD.`,
          policy: {
            allow: true,
            reason: "Governed memory route-deviation-15 changed the outcome from a partial refund to a dismissal.",
          },
        },
        actor,
      );
    }

    const { legs, clawbackCents } = clawbackLegs({
      driverId: trip.driverId,
      riderId: trip.riderId,
      refundCents: extraCents,
      pendingCents: books.pendingCents,
      payableCents: books.payableCents,
    });
    return withAuthority(
      {
        action: "RESOLVE_REFUND",
        refundCad: fromCents(extraCents),
        clawbackCad: fromCents(clawbackCents),
        reversalKind: "EARNINGS_CLAWBACK",
        idempotencyKey: `clawback:dispute:${dispute._id}`,
        legs,
        memoriesUsed: routeMemory ? [{ id: routeMemory._id, text: routeMemory.text }] : [],
        counterfactual: null,
        thought: `Route ran ${(ratio * 100).toFixed(1)}% long and the dismissal rule does not apply. Refund the extra-distance share.`,
        policy: {
          allow: true,
          reason: "Partial fare refund is limited to the extra-distance share and clawed back from provider earnings.",
        },
      },
      actor,
    );
  }

  return emptyDecision(
    "AWAIT_AUTHORITY",
    "No automated reversal rule matched this complaint and ledger. The run waits for an operator instead of guessing a refund.",
  );
}

function deviationRatio(trip) {
  const expected = Number(trip?.expectedDistanceKm);
  const actual = Number(trip?.actualDistanceKm);
  if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(actual)) return null;
  return (actual - expected) / expected;
}

export function legsBalance(legs) {
  if (!legs?.length) return true;
  return balanced(legs);
}
