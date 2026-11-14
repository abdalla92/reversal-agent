import { runDispute, shutdown } from "./agent.js";

const args = process.argv.slice(2);
let disputeId;
let actorId = "agent:dispute-resolver";
let sessionId = `ask-${Date.now()}`;
const text = [];

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--dispute") disputeId = args[++i];
  else if (args[i] === "--actor") actorId = args[++i];
  else if (args[i] === "--session") sessionId = args[++i];
  else text.push(args[i]);
}

const result = await runDispute({
  tenantId: "gotia",
  actorId,
  disputeId,
  sessionId,
  text: text.join(" ").trim(),
});

console.log(result.answer || `(run ${result.status})`);
for (const step of result.transcript) {
  console.log(`\n[${step.tool}] ${step.thought}`);
  if (step.observation) console.log(step.observation);
}
await shutdown();
