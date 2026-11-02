/**
 * Records real agent runs into src/runs/recorded.json, the sample traces the site opens
 * with. Needs DEEPSEEK_API_KEY:  npm run record:runs
 */
import { writeFileSync } from "node:fs";
import { DEFAULT_TASK } from "../src/lib/agent/incident";
import { runAgent } from "../src/lib/agent/loop";
import { applyEvent, type Run, type Span } from "../src/lib/trace";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("Set DEEPSEEK_API_KEY.");
  process.exit(1);
}

const PLANS = [
  { id: "flash-flaky", name: "Flash, metrics outage", model: "deepseek-flash", flaky: true, note: "The first metrics call is made to fail, so the agent has to recover." },
  { id: "pro-flaky", name: "Pro, metrics outage", model: "deepseek-v4-pro", flaky: true, note: "Same task and failure on the larger model. Compare it with the Flash run." },
  { id: "flash-clean", name: "Flash, healthy tools", model: "deepseek-flash", flaky: false, note: "Same task with no injected failure." },
];

async function main() {
  const runs: Run[] = [];
  for (const plan of PLANS) {
    let spans: Span[] = [];
    for await (const e of runAgent({ task: DEFAULT_TASK, apiKey: apiKey!, model: plan.model, flaky: plan.flaky, deadlineMs: 120_000 })) {
      spans = applyEvent(spans, e);
    }
    const root = spans[0];
    console.log(`${plan.id}: ${root.status}, ${spans.length} spans, ${Math.round(root.end ?? 0)}ms\n  ${String(root.output ?? root.error)}\n`);
    if (root.status !== "ok") throw new Error(`${plan.id} failed; recordings left unchanged.`);
    runs.push({
      id: plan.id,
      name: plan.name,
      task: DEFAULT_TASK,
      model: plan.model,
      note: plan.note,
      createdAt: new Date().toISOString(),
      source: "recorded",
      spans,
    });
  }
  writeFileSync("src/runs/recorded.json", JSON.stringify(runs, null, 1) + "\n");
  console.log("Saved src/runs/recorded.json");
}

main();
