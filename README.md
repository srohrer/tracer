# Tracer

**See what your agent actually did.** A timeline for LLM agent runs: every model call and tool call as a span, with latency, tokens, cost and failures. Watch a run stream in live, replay it, inspect any step, and compare two runs side by side.

<!-- Live demo link goes here once deployed -->

## What it does

- **Waterfall:** a virtualized, collapsible span tree on a time axis. Drag the overview to zoom, use ⌘/Ctrl+scroll to zoom around the cursor, Shift+scroll to pan, and arrow keys to move between spans.
- **Live runs:** starts a real tool-calling agent and streams its spans to the browser as NDJSON while it works.
- **Replay:** scrub or play any run at 1×, 2× or 5×. The whole view, including the stats, shows the run as it was at that moment.
- **Inspector:** the exact messages sent to the model, its output and tool calls, tool arguments and results, tokens and estimated cost.
- **Compare:** aligns two runs with a longest-common-subsequence diff on span identity, so you can see where they took different paths, along with duration, token and cost deltas.
- **Import and export:** reads and writes Tracer's JSON, and imports OpenTelemetry OTLP/JSON traces using the `gen_ai.*` semantic conventions.

## The demo agent

The agent is an on-call SRE investigating a fictional outage. **The model calls are real** (DeepSeek, with streaming tool calls). **The tools are simulated:** they serve fixed data and sleep for a set time, so the timeline resembles real infrastructure. The outage has a red herring, a CDN change shortly before the real cause, and the first metrics call is made to fail so traces show a realistic error and retry.

The three sample runs in `src/runs/recorded.json` are captured from real agent runs with `npm run record:runs`, not written by hand.

## Design notes

- **Parallel work isn't double counted.** "Time in the model" is the union of intervals, so overlapping spans count once.
- **Nanosecond timestamps survive import.** OTLP times exceed 2^53, so they're made relative to the trace start with BigInt before becoming numbers.
- **Failures never leave a span open.** The agent loop closes every span on API errors, and the client closes any left open if the stream dies.
- **Bounded costs.** Live runs have a step limit, a time limit, a token cap and per-IP and daily rate limits. The last allowed step forces a conclusion with `tool_choice: "none"`.

## Tech

Next.js 16 · React 19 · TypeScript · Tailwind v4 · TanStack Virtual · Zustand · Zod · Vitest · DeepSeek

```
src/lib/
  trace.ts        span and run model, streamed event reducer
  analysis.ts     tree flattening, stats, replay, run diffing
  importers.ts    native and OTLP/JSON import
  agent/loop.ts   the tool-calling agent, emitting span events
  agent/incident.ts  the simulated environment
src/components/   waterfall, overview, inspector, compare view
```

## Running locally

```bash
npm install
cp .env.example .env.local   # add DEEPSEEK_API_KEY for live runs; recorded runs work without it
npm run dev
```

`npm test` runs the analysis, import and agent loop tests, using a fake streaming model API.

## License

MIT
