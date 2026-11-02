import type { RunEvent, Usage } from "../trace";
import { runTool, SYSTEM_PROMPT, toolLatency, ToolError, TOOLS, type ToolContext } from "./incident";

export interface AgentOptions {
  task: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  flaky?: boolean;
  maxSteps?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

interface Chunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
}

type Message = Record<string, unknown>;

/** Parses an OpenAI-compatible SSE stream, yielding text and collecting tool calls. */
async function* readCompletion(res: Response, out: { calls: ToolCall[]; usage?: Usage; model?: string; text: string }) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.model) out.model = chunk.model;
      if (chunk.usage) {
        out.usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          cached: chunk.usage.prompt_cache_hit_tokens ?? 0,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      for (const tc of delta?.tool_calls ?? []) {
        const call = (out.calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
      if (delta?.content) {
        out.text += delta.content;
        yield delta.content;
      }
    }
  }
}

/**
 * Runs the tool-calling agent, emitting a span event for everything it does. Each step
 * is one model call plus the tools it requested, with parallel requests run in parallel.
 */
export async function* runAgent(opts: AgentOptions): AsyncGenerator<RunEvent> {
  const {
    task,
    apiKey,
    model = "deepseek-flash",
    baseUrl = "https://api.deepseek.com",
    flaky = false,
    maxSteps = 8,
    deadlineMs = 50_000,
    signal,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const t0 = Date.now();
  const now = () => Date.now() - t0;
  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${++nextId}`;
  const ctx: ToolContext = { flaky, metricsCalls: 0 };

  const rootId = id("run");
  yield { t: "span_start", span: { id: rootId, parentId: null, kind: "agent", name: "agent.run", start: 0, end: null, status: "running", input: task, model } };

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  const finishRoot = (status: "ok" | "error", output?: string, error?: string): RunEvent => ({
    t: "span_end",
    id: rootId,
    end: now(),
    status,
    output,
    error,
  });

  for (let step = 1; step <= maxSteps; step++) {
    if (now() > deadlineMs) {
      yield finishRoot("error", undefined, `Stopped at the ${Math.round(deadlineMs / 1000)}s time limit.`);
      yield { t: "done" };
      return;
    }

    const stepId = id("step");
    yield { t: "span_start", span: { id: stepId, parentId: rootId, kind: "agent", name: `step ${step}`, start: now(), end: null, status: "running" } };

    const llmId = id("llm");
    const lastStep = step === maxSteps;
    yield {
      t: "span_start",
      span: { id: llmId, parentId: stepId, kind: "llm", name: "chat.completion", start: now(), end: null, status: "running", model, input: structuredClone(messages) },
    };

    const out: { calls: ToolCall[]; usage?: Usage; model?: string; text: string } = { calls: [], text: "" };
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOLS,
          // on the last allowed step, force a conclusion instead of another tool call
          tool_choice: lastStep ? "none" : "auto",
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: "disabled" },
          temperature: 0.2,
          max_tokens: 1024,
        }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Model API returned ${res.status}. ${detail.slice(0, 200)}`);
      }
      for await (const text of readCompletion(res, out)) yield { t: "span_delta", id: llmId, text };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      yield { t: "span_end", id: llmId, end: now(), status: "error", error: message };
      yield { t: "span_end", id: stepId, end: now(), status: "error" };
      yield finishRoot("error", undefined, message);
      yield { t: "done" };
      return;
    }

    const calls = out.calls.filter(Boolean);
    yield {
      t: "span_end",
      id: llmId,
      end: now(),
      status: "ok",
      usage: out.usage,
      model: out.model,
      output: calls.length ? { text: out.text || undefined, tool_calls: calls.map((c) => ({ name: c.name, arguments: c.args })) } : out.text,
    };

    if (!calls.length) {
      yield { t: "span_end", id: stepId, end: now(), status: "ok" };
      yield finishRoot("ok", out.text);
      yield { t: "done" };
      return;
    }

    messages.push({
      role: "assistant",
      content: out.text || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
    });

    // Parallel calls overlap on the timeline; finish events arrive as each tool completes.
    const pending = calls.map((call) => ({ call, spanId: id("tool") }));
    for (const { call, spanId } of pending) {
      let input: unknown = call.args;
      try {
        input = JSON.parse(call.args || "{}");
      } catch {
        /* show the raw text; the tool call fails below */
      }
      yield { t: "span_start", span: { id: spanId, parentId: stepId, kind: "tool", name: call.name, start: now(), end: null, status: "running", input } };
    }

    const queue: RunEvent[] = [];
    let wake: (() => void) | null = null;
    const results = pending.map(async ({ call, spanId }) => {
      await sleep(toolLatency(call.name));
      let content: string;
      let event: RunEvent;
      try {
        const output = runTool(call.name, JSON.parse(call.args || "{}"), ctx);
        content = JSON.stringify(output);
        event = { t: "span_end", id: spanId, end: now(), status: "ok", output };
      } catch (e) {
        if (!(e instanceof ToolError || e instanceof SyntaxError)) throw e;
        content = JSON.stringify({ error: e.message });
        event = { t: "span_end", id: spanId, end: now(), status: "error", error: e.message };
      }
      queue.push(event);
      wake?.();
      return { role: "tool", tool_call_id: call.id, content };
    });

    let finished = 0;
    while (finished < pending.length) {
      if (!queue.length) await new Promise<void>((r) => (wake = r));
      wake = null;
      while (queue.length) {
        yield queue.shift()!;
        finished++;
      }
    }
    messages.push(...(await Promise.all(results)));
    yield { t: "span_end", id: stepId, end: now(), status: "ok" };
  }

  yield finishRoot("error", undefined, "The agent ran out of steps.");
  yield { t: "done" };
}
