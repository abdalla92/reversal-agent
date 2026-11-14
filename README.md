# Reversal agent

This folder is the hackathon project. The rest of the repository is the existing GOTIA platform and is not part of the submission.

An auditable agent that resolves GOTIA transaction-reversal disputes. MongoDB Atlas holds the case graph, the ledger mirror, short-term session memory, governed long-term memory, and the run checkpoint.

The decision rules follow the platform wallet:

- A cancelled trip refunds the captured cancellation fee, split 80% driver / 20% platform, and credits the rider the full fee.
- A completed-trip refund claws provider earnings back, capped at what the provider still holds. The platform absorbs the rest.
- The agent may post a reversal at or under 25 CAD. Above that it waits for an operator with `dispute.resolve.elevated`.
- Open and under-review disputes keep provider earnings in the reserve.

Atlas is the agent's system of record for this demo. Posting here does not move the live Postgres wallet. The idempotency keys match the platform (`cancel-fee-reversal:<tripId>`, `clawback:dispute:<disputeId>`) so an operator can apply the same posting there.

## Run

```bash
cd hackathon/reversal-agent
npm install
cp .env.example .env
# paste the Atlas sandbox connection string into MONGODB_URI
npm test
npm run demo
```

One complaint, without the scripted demo:

```bash
node src/ask.js --dispute dispute:dsp-cancel "Driver never arrived and I was charged a cancellation fee"
```

`VOYAGE_API_KEY` switches embeddings to Voyage. `PLANNER=llm` plus `OPENAI_API_KEY` lets the model choose the next tool. Policy still runs inside the tool, so the model cannot post a reversal the actor is not allowed to make. With neither key, the demo uses a local embedder and a deterministic ReAct planner.

## What the demo shows

1. A route complaint 8% over the expected distance is dismissed because long-term memory `mem-route-15` is retrieved. The run records the counterfactual: without that memory the refund would be 3.36 CAD. A second question in the same session is answered from short-term memory and does not touch the ledger.
2. A duplicate 86 CAD charge is planned, then suspended, because it is over the auto-resolve cap. Resuming as `ops:amina` posts one clawback.
3. The cancellation-fee reversal is posted and the process crashes before that step is marked verified. Resume retries the sent step. The idempotency key blocks a second posting. The rider is credited 8.00, the driver debited 6.40, and the platform debited 1.60.
4. Rollback writes a compensating ledger entry and leaves the original row in place. The dispute returns to review.
5. Forgetting a memory hides it from the next recall. Another tenant's memory and a party-only note are never returned to the agent.

Every tool call is an audit document with the actor, the policy decision, and the outcome.
