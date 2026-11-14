import { randomUUID } from "node:crypto";
import {
  appendSession,
  checkEarningsHold,
  checkPolicy,
  commitResolution,
  graphLookup,
  inspectLedger,
  loadActor,
  loadCase,
  readSession,
  recallMemories,
  suspendForAuthority,
} from "./tools.js";
import { close, connect } from "./store.js";

export class SimulatedCrash extends Error {
  constructor() {
    super("CRASH_SIMULATED");
    this.name = "SimulatedCrash";
  }
}

const THOUGHTS = {
  load_case: "The complaint is the perception step. I need the dispute and the trip it points at before any tool that moves money.",
  graph_lookup: "Next I walk the dispute's relationships so the trip, rider, driver, and ledger nodes have to be connected, not inferred from the wording.",
  recall_memories: "I look up governed long-term memory and similar closed cases. Another tenant's memory and party-only notes stay out of this result.",
  inspect_ledger: "The ledger, not the complaint, decides whether a fee was captured or a ride was billed twice.",
  check_policy: "I apply the reversal rules to the graph, the ledger, and only the memories this actor is allowed to read.",
  commit_resolution: "Policy allows this actor to post the reversal. The ledger write uses an idempotency key so a retry cannot double-charge.",
  suspend_for_authority: "The refund is above the auto-resolve cap or the rule is incomplete. I stop and wait instead of posting it.",
  check_earnings_hold: "Earnings release is a second system. I check whether this dispute still blocks the provider reserve.",
  finish: "The verified steps are enough to answer. I will not replay the ones already marked verified.",
};

function scratchKey(tool) {
  if (tool === "commit_resolution" || tool === "suspend_for_authority") return "act";
  return tool;
}

function nextTool(scratch) {
  for (const name of ["load_case", "graph_lookup", "recall_memories", "inspect_ledger", "check_policy"]) {
    if (!scratch[name]) return name;
  }
  if (!scratch.act) {
    const action = scratch.check_policy?.plan?.action;
    if (action === "RESOLVE_REFUND" || action === "DISMISS") return "commit_resolution";
    if (action === "AWAIT_AUTHORITY") return "suspend_for_authority";
    return "finish";
  }
  if (!scratch.check_earnings_hold && scratch.act?.disputeStatus) return "check_earnings_hold";
  return "finish";
}

function answerFrom(scratch) {
  const committed = scratch.act?.plan;
  const planned = scratch.check_policy?.plan;
  const plan = committed?.action === "NOOP" && planned ? planned : committed || planned;
  if (!plan) return "The run stopped before a decision.";
  const parts = [plan.thought, plan.policy?.reason].filter(Boolean);
  if (plan.counterfactual) {
    parts.push(
      `Counterfactual without that memory: ${plan.counterfactual.reason} Refund would be ${Number(plan.counterfactual.refundCad).toFixed(2)} CAD.`,
    );
  }
  const similar = scratch.recall_memories?.similarCases || [];
  if (similar.length) {
    parts.push(`Similar closed cases retrieved: ${similar.map((item) => `${item._id} (${item.status})`).join(", ")}.`);
  }
  if (scratch.check_earnings_hold) parts.push(scratch.check_earnings_hold.reason);
  if (scratch.act?.idempotent) parts.push("A resumed run found the reversal already posted and did not write it again.");
  if (scratch.act?.awaiting) parts.push("Run status is AWAITING_AUTHORITY. Resume with an elevated actor to finish the posting.");
  return parts.join(" ");
}

async function executeTool(db, tool, ctx) {
  const { tenantId, actor, run, scratch } = ctx;
  const disputeId = scratch.load_case?.dispute?._id || run.disputeId;
  if (tool === "load_case") {
    return loadCase(db, { tenantId, disputeId: run.disputeId, text: run.text });
  }
  if (tool === "graph_lookup") {
    return graphLookup(db, { tenantId, disputeId });
  }
  if (tool === "recall_memories") {
    return recallMemories(db, {
      tenantId,
      actor,
      query: run.text || scratch.load_case?.dispute?.reason,
      disputeId,
    });
  }
  if (tool === "inspect_ledger") {
    return inspectLedger(db, { tenantId, tripId: scratch.load_case.dispute.tripId });
  }
  if (tool === "check_policy") {
    return checkPolicy(db, {
      tenantId,
      actor,
      disputeId,
      memories: scratch.recall_memories?.memories || [],
      perceptionText: run.text,
      graph: scratch.graph_lookup,
    });
  }
  if (tool === "commit_resolution") {
    const posted = await commitResolution(db, {
      tenantId,
      actor,
      runId: run._id,
      disputeId,
      memories: scratch.recall_memories?.memories || [],
      perceptionText: run.text,
      graph: scratch.graph_lookup,
    });
    if (!posted.committed && posted.plan?.action === "AWAIT_AUTHORITY") {
      return suspendForAuthority(db, { tenantId, actor, runId: run._id, disputeId, plan: posted.plan });
    }
    return posted;
  }
  if (tool === "suspend_for_authority") {
    return suspendForAuthority(db, {
      tenantId,
      actor,
      runId: run._id,
      disputeId,
      plan: scratch.check_policy?.plan,
    });
  }
  if (tool === "check_earnings_hold") {
    return checkEarningsHold(db, { tenantId, disputeId });
  }
  return { done: true };
}

async function chooseTool(scratch, text) {
  const playbook = nextTool(scratch);
  if (process.env.PLANNER !== "llm" || !process.env.OPENAI_API_KEY) {
    return { tool: playbook, thought: THOUGHTS[playbook], planner: "playbook" };
  }
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are the planner for a dispute-reversal agent. Reply with JSON {\"tool\",\"thought\"}. " +
              "Choose the next tool that is not done yet. Tools: load_case, graph_lookup, recall_memories, inspect_ledger, check_policy, commit_resolution, suspend_for_authority, check_earnings_hold, finish. " +
              "Do not choose commit_resolution unless check_policy.plan.policy.allow is true. Do not choose a tool whose observation is already present.",
          },
          {
            role: "user",
            content: JSON.stringify({ complaint: text, completed: Object.keys(scratch), policy: scratch.check_policy?.plan?.action || null }),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const json = await response.json();
    const raw = json.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const allowed = new Set([
      "load_case",
      "graph_lookup",
      "recall_memories",
      "inspect_ledger",
      "check_policy",
      "commit_resolution",
      "suspend_for_authority",
      "check_earnings_hold",
      "finish",
    ]);
    if (!allowed.has(parsed.tool) || scratch[scratchKey(parsed.tool)]) {
      return { tool: playbook, thought: THOUGHTS[playbook], planner: "playbook" };
    }
    return { tool: parsed.tool, thought: parsed.thought || THOUGHTS[parsed.tool], planner: "llm" };
  } catch {
    return { tool: playbook, thought: THOUGHTS[playbook], planner: "playbook" };
  }
}

async function saveRun(db, run) {
  run.updatedAt = new Date();
  await db.collection("runs").replaceOne({ _id: run._id }, run, { upsert: true });
}

export async function runDispute(input) {
  const db = input.db || (await connect());
  const tenantId = input.tenantId || "gotia";
  const actor = await loadActor(db, input.actorId, tenantId);
  const session = input.sessionId ? await readSession(db, input.sessionId) : null;
  const prior = session?.interactions?.filter((item) => item.role === "assistant").at(-1);

  if (prior && /^why\b/i.test(input.text || "") && !input.resumeRunId) {
    const runId = `session-${input.sessionId}`;
    await db.collection("audit").insertOne({
      tenantId,
      runId,
      actorId: actor._id,
      tool: "short_term_memory",
      outcome: "verified",
      policy: { allow: true, reason: "Answered from this session. No ledger tool was called." },
      args: { sessionId: input.sessionId },
      at: new Date(),
    });
    return {
      runId,
      status: "COMPLETED",
      answer: prior.content,
      fromMemory: "short-term",
      transcript: [],
      db,
    };
  }

  let run;
  if (input.resumeRunId) {
    run = await db.collection("runs").findOne({ _id: input.resumeRunId, tenantId });
    if (!run) throw new Error(`Run ${input.resumeRunId} was not found.`);
    if (run.actorId !== actor._id) {
      run.actorId = actor._id;
      delete run.scratch.check_policy;
      delete run.scratch.act;
      if (run.status === "AWAITING_AUTHORITY") run.status = "RUNNING";
    }
  } else {
    run = {
      _id: randomUUID(),
      tenantId,
      actorId: actor._id,
      sessionId: input.sessionId || randomUUID(),
      disputeId: input.disputeId || null,
      text: input.text || "",
      status: "RUNNING",
      steps: [],
      scratch: {},
      createdAt: new Date(),
    };
  }

  if (input.sessionId && input.text && !input.resumeRunId) {
    await appendSession(db, {
      sessionId: run.sessionId,
      tenantId,
      actorId: actor._id,
      role: "user",
      content: input.text,
    });
  }

  const transcript = [];
  try {
    for (let step = 0; step < 10; step += 1) {
      const last = run.steps[run.steps.length - 1];
      const retrying = last?.status === "sent";
      const choice = retrying
        ? { tool: last.name, thought: "The last step was sent and never verified. Retry that tool. The ledger key makes the retry safe.", planner: "resume" }
        : await chooseTool(run.scratch, run.text);
      if (
        choice.planner !== "resume" &&
        choice.tool === "commit_resolution" &&
        run.scratch.check_policy?.plan?.action === "DISMISS"
      ) {
        choice.thought = "Policy allows a dismissal. No money moves, and the dispute is closed so earnings can leave the reserve.";
      }
      if (choice.tool === "finish") {
        run.answer = answerFrom(run.scratch);
        run.status = "COMPLETED";
        run.steps.push({ name: "finish", status: "verified", at: new Date(), thought: choice.thought, planner: choice.planner });
        transcript.push({ thought: choice.thought, tool: "finish", planner: choice.planner });
        break;
      }

      if (!retrying) {
        run.steps.push({ name: choice.tool, status: "sent", at: new Date(), thought: choice.thought, planner: choice.planner });
        await saveRun(db, run);
      }
      if (input.crashBefore === choice.tool) throw new SimulatedCrash();

      const observation = await executeTool(db, choice.tool, { tenantId, actor, run, scratch: run.scratch });
      if (input.crashAfter === choice.tool) {
        transcript.push({
          thought: choice.thought,
          tool: choice.tool,
          planner: choice.planner,
          observation: `${summarize(choice.tool, observation)} (sent, not verified)`,
        });
        await saveRun(db, run);
        throw new SimulatedCrash();
      }

      const current = run.steps[run.steps.length - 1];
      current.status = "verified";
      current.verifiedAt = new Date();
      run.scratch[scratchKey(choice.tool)] = observation;
      if (choice.tool === "load_case" && observation.dispute) run.disputeId = observation.dispute._id;
      if (observation.awaiting) run.status = "AWAITING_AUTHORITY";
      transcript.push({
        thought: choice.thought,
        tool: choice.tool,
        planner: choice.planner,
        observation: summarize(choice.tool, observation),
      });
      await saveRun(db, run);
      if (input.stopAfter === choice.tool || run.status === "AWAITING_AUTHORITY") break;
    }

    if (!run.answer) {
      run.answer = answerFrom(run.scratch);
      if (run.status === "RUNNING") run.status = run.scratch.act?.awaiting ? "AWAITING_AUTHORITY" : "COMPLETED";
    }
    await saveRun(db, run);
    if (run.sessionId && run.answer && run.status === "COMPLETED") {
      await appendSession(db, {
        sessionId: run.sessionId,
        tenantId,
        actorId: actor._id,
        role: "assistant",
        content: run.answer,
      });
    }
    return { runId: run._id, status: run.status, answer: run.answer, transcript, fromMemory: null, db };
  } catch (error) {
    if (error instanceof SimulatedCrash) {
      run.status = "RUNNING";
      await saveRun(db, run);
      return { runId: run._id, status: "CRASHED", answer: null, transcript, fromMemory: null, db };
    }
    run.status = "FAILED";
    run.error = error.message;
    await saveRun(db, run);
    throw error;
  }
}

function summarize(tool, observation) {
  if (tool === "load_case") return observation.found ? observation.dispute._id : observation.reason;
  if (tool === "graph_lookup") {
    return `${observation.connected?.length || 0} connected nodes, trip reached: ${Boolean(observation.reachedTrip)}`;
  }
  if (tool === "recall_memories") {
    return `source ${observation.source}, memories ${(observation.memories || []).map((memory) => memory._id).join(", ") || "none"}, withheld ${observation.withheld}`;
  }
  if (tool === "inspect_ledger") return `${observation.entries?.length || 0} ledger entries`;
  if (tool === "check_policy") return `${observation.plan?.action}: ${observation.plan?.policy?.reason}`;
  if (tool === "commit_resolution") {
    return observation.idempotent ? "idempotent, already posted" : `posted, status ${observation.disputeStatus}`;
  }
  if (tool === "suspend_for_authority") return "awaiting elevated actor";
  if (tool === "check_earnings_hold") return observation.reason;
  return "ok";
}

export async function shutdown() {
  await close();
}
