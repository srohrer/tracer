import { describe, expect, it } from "vitest";
import { runAgent } from "../agent/loop";
import { atTime, diffRuns, flatten, niceStep, runStats, spanCost } from "../analysis";
import { parseTraceFile } from "../importers";
import { applyEvent, type RunEvent, type Span } from "../trace";

const span = (over: Partial<Span> & { id: string }): Span => ({
  parentId: null,
  kind: "tool",
  name: over.id,
  start: 0,
  end: 100,
  status: "ok",
  ...over,
});

const tree: Span[] = [
  span({ id: "root", kind: "agent", name: "agent.run", end: 1000 }),
  span({ id: "s1", kind: "agent", name: "step 1", parentId: "root", end: 600 }),
  span({ id: "l1", kind: "llm", name: "chat", parentId: "s1", end: 200, model: "deepseek-flash", usage: { input: 1000, output: 100, cached: 500 } }),
  span({ id: "a", name: "get_metrics", parentId: "s1", start: 200, end: 500 }),
  span({ id: "b", name: "get_deploys", parentId: "s1", start: 300, end: 600, status: "error", error: "boom" }),
];

describe("flatten", () => {
  it("orders depth-first and honors collapse", () => {
    expect(flatten(tree).map((r) => `${r.depth}:${r.span.id}`)).toEqual(["0:root", "1:s1", "2:l1", "2:a", "2:b"]);
    expect(flatten(tree, new Set(["s1"])).map((r) => r.span.id)).toEqual(["root", "s1"]);
  });
  it("keeps orphans as roots", () => {
    expect(flatten([span({ id: "x", parentId: "missing" })])[0].depth).toBe(0);
  });
});

describe("runStats", () => {
  it("doesn't double count parallel tools", () => {
    const s = runStats({ spans: tree });
    expect(s.activeMs.tool).toBe(400); // 200-600, though the two calls total 600
    expect(s).toMatchObject({ duration: 1000, llmCalls: 1, toolCalls: 2, errors: 1, inputTokens: 1000, outputTokens: 100 });
  });
  it("prices cached tokens separately", () => {
    expect(spanCost(tree[2])).toBeCloseTo((500 * 0.3 + 500 * 0.006 + 100 * 1.2) / 1e6);
    expect(spanCost(span({ id: "u", usage: { input: 10, output: 10 }, model: "mystery" }))).toBe(0);
  });
});

describe("atTime", () => {
  it("shows the run as it was at a moment", () => {
    const at = atTime(tree, 250);
    expect(at.map((s) => s.id)).toEqual(["root", "s1", "l1", "a"]);
    expect(at.find((s) => s.id === "l1")!.end).toBe(200);
    expect(at.find((s) => s.id === "a")).toMatchObject({ end: null, status: "running" });
    expect(runStats({ spans: atTime(tree, 150) }).inputTokens).toBe(0); // usage arrives on completion
  });
});

describe("diffRuns", () => {
  it("aligns matching spans and reports additions, removals and changes", () => {
    const other: Span[] = [
      span({ id: "root2", kind: "agent", name: "agent.run", end: 1600 }),
      span({ id: "s2", kind: "agent", name: "step 1", parentId: "root2", end: 1500 }),
      span({ id: "l2", kind: "llm", name: "chat", parentId: "s2", end: 210 }),
      span({ id: "c", name: "search_logs", parentId: "s2", start: 210, end: 400 }),
      span({ id: "b2", name: "get_deploys", parentId: "s2", start: 400, end: 700 }),
    ];
    const d = diffRuns({ spans: tree }, { spans: other });
    expect(d.rows.map((r) => `${r.kind}:${(r.b ?? r.a)!.name}`)).toEqual([
      "changed:agent.run",
      "changed:step 1",
      "same:chat",
      "added:search_logs",
      "removed:get_metrics",
      "changed:get_deploys",
    ]);
    expect(d.rows[5].statusChanged).toBe(true);
    expect(d.rows[0].durationDelta).toBe(600);
  });
  it("aligns numbered steps regardless of their number", () => {
    const d = diffRuns({ spans: [span({ id: "a", kind: "agent", name: "step 2" })] }, { spans: [span({ id: "b", kind: "agent", name: "step 7" })] });
    expect(d.rows[0].kind).toBe("same");
  });
});

describe("niceStep", () => {
  it("picks round tick spacing", () => {
    expect(niceStep(10_000)).toBe(2000);
    expect(niceStep(700)).toBe(200);
  });
});

describe("parseTraceFile", () => {
  const attr = (key: string, value: object) => ({ key, value });
  const otlp = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              { traceId: "t1", spanId: "r", name: "invoke_agent", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000002000000000" },
              {
                traceId: "t1",
                spanId: "c",
                parentSpanId: "r",
                name: "chat gpt",
                startTimeUnixNano: "1700000000500000000",
                endTimeUnixNano: "1700000001000000000",
                attributes: [
                  attr("gen_ai.operation.name", { stringValue: "chat" }),
                  attr("gen_ai.request.model", { stringValue: "deepseek-flash" }),
                  attr("gen_ai.usage.input_tokens", { intValue: "120" }),
                  attr("gen_ai.usage.output_tokens", { intValue: 30 }),
                ],
              },
              {
                traceId: "t1",
                spanId: "x",
                parentSpanId: "r",
                name: "execute_tool",
                startTimeUnixNano: "1700000001000000000",
                endTimeUnixNano: "1700000001250000000",
                status: { code: 2, message: "nope" },
                attributes: [attr("gen_ai.tool.name", { stringValue: "search" })],
              },
            ],
          },
        ],
      },
    ],
  };

  it("maps OTLP GenAI spans without losing nanosecond precision", () => {
    const [run] = parseTraceFile(JSON.stringify(otlp), "t.json");
    const by = Object.fromEntries(run.spans.map((s) => [s.id, s]));
    expect(by.r).toMatchObject({ kind: "agent", start: 0, end: 2000, parentId: null });
    expect(by.c).toMatchObject({ kind: "llm", start: 500, end: 1000, model: "deepseek-flash", usage: { input: 120, output: 30 } });
    expect(by.x).toMatchObject({ kind: "tool", status: "error", error: "nope", end: 1250 });
  });
  it("round-trips native exports and rejects junk", () => {
    const native = { id: "a", name: "n", createdAt: "2026-01-01", source: "live", spans: tree };
    expect(parseTraceFile(JSON.stringify(native), "n.json")[0]).toMatchObject({ name: "n", source: "imported" });
    expect(() => parseTraceFile("{nope", "x.json")).toThrow(/valid JSON/);
    expect(() => parseTraceFile("{}", "x.json")).toThrow(/isn't a Tracer/);
  });
});

// A fake model API: replays scripted SSE responses and records what it was sent.
function fakeApi(responses: string[][]) {
  const bodies: { messages: { role: string }[]; tool_choice: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const lines = responses[Math.min(bodies.length - 1, responses.length - 1)];
    return new Response(lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n");
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

const toolCallChunks = (name: string, args: string, index = 0, id = `call_${name}`) => [
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args.slice(0, 5) } }] } }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] }),
];
const usage = JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 } });
const say = (t: string) => JSON.stringify({ model: "deepseek-flash", choices: [{ delta: { content: t } }] });

async function run(responses: string[][], opts: { flaky?: boolean; maxSteps?: number } = {}) {
  const api = fakeApi(responses);
  const events: RunEvent[] = [];
  let spans: Span[] = [];
  for await (const e of runAgent({ task: "why?", apiKey: "k", fetchImpl: api.fetchImpl, sleep: async () => {}, ...opts })) {
    events.push(e);
    spans = applyEvent(spans, e);
  }
  return { events, spans, bodies: api.bodies };
}

describe("runAgent", () => {
  it("assembles streamed tool calls, runs tools, and finishes on a text reply", async () => {
    const { spans, bodies, events } = await run([
      [...toolCallChunks("get_deploys", '{"service":"payments-api"}'), usage],
      [say("Roll "), say("back."), usage],
    ]);
    expect(events.at(-1)).toEqual({ t: "done" });
    expect(flatten(spans).map((r) => `${r.depth}:${r.span.name}`)).toEqual([
      "0:agent.run",
      "1:step 1",
      "2:chat.completion",
      "2:get_deploys",
      "1:step 2",
      "2:chat.completion",
    ]);
    const tool = spans.find((s) => s.name === "get_deploys")!;
    expect(tool.status).toBe("ok");
    expect(tool.input).toEqual({ service: "payments-api" });
    expect(JSON.stringify(tool.output)).toContain("v2.14.0");
    expect(spans.find((s) => s.kind === "llm")!.usage).toEqual({ input: 100, output: 20, cached: 40 });
    expect(spans[0]).toMatchObject({ status: "ok", output: "Roll back." });
    expect(spans.every((s) => s.status !== "running")).toBe(true);
    expect(bodies[1].messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  it("runs parallel calls side by side and answers each one", async () => {
    const { spans, bodies } = await run([
      [...toolCallChunks("list_services", "{}", 0, "a"), ...toolCallChunks("get_deploys", "{}", 1, "b"), usage],
      [say("done"), usage],
    ]);
    expect(spans.filter((s) => s.kind === "tool").map((s) => s.name)).toEqual(["list_services", "get_deploys"]);
    expect(bodies[1].messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("records tool failures and lets the model recover", async () => {
    const args = '{"service":"cdn","metric":"cache_hit_pct"}';
    const { spans } = await run(
      [[...toolCallChunks("get_metrics", args), usage], [...toolCallChunks("get_metrics", args), usage], [say("ok"), usage]],
      { flaky: true },
    );
    const metrics = spans.filter((s) => s.name === "get_metrics");
    expect(metrics.map((s) => s.status)).toEqual(["error", "ok"]);
    expect(metrics[0].error).toMatch(/timed out/);
    expect(spans[0].status).toBe("ok");
  });

  it("reports malformed tool arguments as a tool error", async () => {
    const { spans } = await run([[...toolCallChunks("get_metrics", "{not json"), usage], [say("ok"), usage]]);
    expect(spans.find((s) => s.name === "get_metrics")!.status).toBe("error");
  });

  it("forces a conclusion on the last step", async () => {
    const { bodies, spans } = await run([[...toolCallChunks("list_services", "{}"), usage], [say("fine"), usage]], { maxSteps: 2 });
    expect(bodies.map((b) => b.tool_choice)).toEqual(["auto", "none"]);
    expect(spans[0].status).toBe("ok");
  });

  it("closes every span when the API fails", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    let spans: Span[] = [];
    for await (const e of runAgent({ task: "x", apiKey: "k", fetchImpl })) spans = applyEvent(spans, e);
    expect(spans.map((s) => s.status)).toEqual(["error", "error", "error"]);
    expect(spans[0].error).toMatch(/500/);
  });
});
