import { pathToFileURL } from "node:url";
import { runDispute, shutdown } from "./agent.js";
import { seed } from "./seed.js";
import { connect, ensure } from "./store.js";
import { forgetMemory, loadActor, recallMemories, rollbackReversal } from "./tools.js";

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function printRun(title, result) {
  console.log(`\n=== ${title} ===`);
  console.log(`status: ${result.status}`);
  for (const step of result.transcript) {
    console.log(`- [${step.planner}] ${step.tool}`);
    console.log(`  thought: ${step.thought}`);
    if (step.observation) console.log(`  observation: ${step.observation}`);
  }
  if (result.answer) console.log(`answer: ${result.answer}`);
}

export async function runDemo(db) {
  await ensure(db);
  await seed(db, { reset: true });

  const route = await runDispute({
    db,
    tenantId: "gotia",
    actorId: "agent:dispute-resolver",
    disputeId: "dispute:dsp-route",
    sessionId: "session-route",
    text: "Driver took a longer route. Expected 10 km and we drove 10.8 km.",
  });
  printRun("Route deviation — memory dismisses it", route);
  const routeRun = await db.collection("runs").findOne({ _id: route.runId });
  const remembered = routeRun.scratch.recall_memories.memories.map((memory) => memory._id);
  expect(route.status === "COMPLETED", "Route case should complete");
  expect(remembered[0] === "mem-route-15", "The route rule should be the closest memory, not a cancellation note");
  expect(!remembered.includes("mem-other-tenant"), "Another tenant's memory leaked into the recall");
  expect(!remembered.includes("mem-rider-private"), "A party-only memory was readable by the agent");
  expect(routeRun.scratch.act.plan.action === "DISMISS", "Memory should dismiss the route dispute");
  expect(routeRun.scratch.act.plan.counterfactual.refundCad === 3.36, "Counterfactual refund should be 3.36 CAD");
  expect(routeRun.scratch.check_earnings_hold.releaseAllowed === true, "A dismissed dispute should release earnings");

  const why = await runDispute({
    db,
    tenantId: "gotia",
    actorId: "agent:dispute-resolver",
    sessionId: "session-route",
    text: "Why was that dismissed?",
  });
  printRun("Same session — short-term memory", why);
  expect(why.fromMemory === "short-term", "Follow-up should answer from the session");
  expect((await db.collection("ledger").countDocuments({ tripId: "trip:t-route" })) === 1, "Follow-up posted a ledger entry");

  const waiting = await runDispute({
    db,
    tenantId: "gotia",
    actorId: "agent:dispute-resolver",
    disputeId: "dispute:dsp-over",
    sessionId: "session-over",
    text: "I was charged twice for the same completed trip",
  });
  printRun("Duplicate charge — above the 25 CAD cap", waiting);
  expect(waiting.status === "AWAITING_AUTHORITY", "The agent should wait instead of posting 86 CAD");
  expect((await db.collection("disputes").findOne({ _id: "dispute:dsp-over" })).status === "UNDER_REVIEW", "Dispute should be under review");

  const posted = await runDispute({
    db,
    tenantId: "gotia",
    actorId: "ops:amina",
    resumeRunId: waiting.runId,
  });
  printRun("Resume with an elevated operator", posted);
  const reversal = await db.collection("ledger").findOne({ idempotencyKey: "clawback:dispute:dispute:dsp-over" });
  expect(posted.status === "COMPLETED", "Elevated resume should finish");
  expect(reversal?.amountCad === 86, "Duplicate reversal should post 86 CAD once");
  expect((await db.collection("disputes").findOne({ _id: "dispute:dsp-over" })).resolvedById === "ops:amina", "Operator should be the authority on the dispute");

  const crashed = await runDispute({
    db,
    tenantId: "gotia",
    actorId: "agent:dispute-resolver",
    disputeId: "dispute:dsp-cancel",
    sessionId: "session-cancel",
    text: "Driver never arrived and I was charged a cancellation fee",
    crashAfter: "commit_resolution",
  });
  printRun("Crash after the reversal is posted, before it is verified", crashed);
  const crashedRun = await db.collection("runs").findOne({ _id: crashed.runId });
  const sent = crashedRun.steps.at(-1);
  expect(crashed.status === "CRASHED", "Crash simulation should stop the run");
  expect(sent?.status === "sent" && sent.name === "commit_resolution", "The commit step should stay sent, not verified");
  expect(
    (await db.collection("ledger").countDocuments({ idempotencyKey: "cancel-fee-reversal:trip:t-cancel" })) === 1,
    "The fee reversal should already be on the ledger",
  );

  const resumed = await runDispute({
    db,
    tenantId: "gotia",
    actorId: "agent:dispute-resolver",
    resumeRunId: crashed.runId,
  });
  printRun("Resume — retry the sent step, do not post it twice", resumed);
  expect(resumed.status === "COMPLETED", "Crashed run should finish on resume");
  expect(
    (await db.collection("ledger").countDocuments({ idempotencyKey: "cancel-fee-reversal:trip:t-cancel" })) === 1,
    "Resume posted a second cancellation reversal",
  );
  const fee = await db.collection("ledger").findOne({ idempotencyKey: "cancel-fee-reversal:trip:t-cancel" });
  const driverDebit = fee.legs.find((leg) => leg.kind === "PROVIDER_PENDING");
  const platformDebit = fee.legs.find((leg) => leg.kind === "PLATFORM_COMMISSION");
  const riderCredit = fee.legs.find((leg) => leg.kind === "RIDER_WALLET");
  expect(driverDebit?.amountCad === 6.4 && driverDebit.direction === "DEBIT", "Driver share should be debited 6.40");
  expect(platformDebit?.amountCad === 1.6 && platformDebit.direction === "DEBIT", "Platform share should be debited 1.60");
  expect(riderCredit?.amountCad === 8 && riderCredit.direction === "CREDIT", "Rider should be credited 8.00");

  const operator = await loadActor(db, "ops:amina", "gotia");
  const rolled = await rollbackReversal(db, { tenantId: "gotia", actor: operator, disputeId: "dispute:dsp-cancel" });
  console.log(`\n=== Rollback the fee reversal ===\ncompensates ${rolled.compensates}, dispute returned to review`);
  expect(rolled.rolledBack === true, "Rollback should post a compensating entry");
  const originalStillThere = await db.collection("ledger").findOne({ idempotencyKey: "cancel-fee-reversal:trip:t-cancel" });
  expect(originalStillThere?.status === "POSTED", "Rollback edited the original ledger row");
  expect((await db.collection("disputes").findOne({ _id: "dispute:dsp-cancel" })).status === "UNDER_REVIEW", "Rolled-back dispute should be under review");

  const beforeForget = await recallMemories(db, {
    tenantId: "gotia",
    actor: operator,
    query: "Old fee schedule refund every cancellation complaint automatically",
    disputeId: "dispute:dsp-cancel",
  });
  expect(beforeForget.memories.some((memory) => memory._id === "mem-stale-fee"), "Stale fee memory should be retrievable before it is forgotten");
  await forgetMemory(db, { tenantId: "gotia", actor: operator, memoryId: "mem-stale-fee" });
  const afterForget = await recallMemories(db, {
    tenantId: "gotia",
    actor: operator,
    query: "Old fee schedule refund every cancellation complaint automatically",
    disputeId: "dispute:dsp-cancel",
  });
  console.log("\n=== Forget a bad memory ===");
  console.log(`before (${beforeForget.source}): ${beforeForget.memories.map((memory) => memory._id).join(", ")}`);
  console.log(`after (${afterForget.source}):  ${afterForget.memories.map((memory) => memory._id).join(", ") || "(none)"}`);
  expect(!afterForget.memories.some((memory) => memory._id === "mem-stale-fee"), "Forgotten memory was retrieved again");

  const audit = await db.collection("audit").find({ tenantId: "gotia" }).sort({ at: 1 }).toArray();
  console.log(`\nAudit rows: ${audit.length}`);
  for (const row of audit) {
    console.log(`- ${row.actorId} ${row.tool} ${row.outcome}`);
  }
  expect(audit.every((row) => row.actorId && row.tool && row.outcome), "Every audit row needs an actor, a tool, and an outcome");

  return { route: route.status, waiting: waiting.status, posted: posted.status, resumed: resumed.status, audit: audit.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await connect();
  try {
    const result = await runDemo(db);
    console.log(`\nDemo passed (${result.audit} audit rows).`);
  } finally {
    await shutdown();
  }
}
