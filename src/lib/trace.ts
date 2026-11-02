import { z } from "zod";

export const UsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cached: z.number().optional(),
});

export const SpanSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(["agent", "llm", "tool"]),
  name: z.string(),
  /** ms since the run started */
  start: z.number(),
  /** null while the span is still running */
  end: z.number().nullable(),
  status: z.enum(["ok", "error", "running"]),
  model: z.string().optional(),
  usage: UsageSchema.optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export const RunSchema = z.object({
  id: z.string(),
  name: z.string(),
  task: z.string().optional(),
  model: z.string().optional(),
  createdAt: z.string(),
  source: z.enum(["recorded", "live", "imported"]),
  note: z.string().optional(),
  spans: z.array(SpanSchema),
});

export type Usage = z.infer<typeof UsageSchema>;
export type Span = z.infer<typeof SpanSchema>;
export type Run = z.infer<typeof RunSchema>;
export type SpanKind = Span["kind"];

/** NDJSON events streamed from /api/run while an agent executes. */
export type RunEvent =
  | { t: "span_start"; span: Span }
  | { t: "span_delta"; id: string; text: string }
  | { t: "span_end"; id: string; end: number; status: "ok" | "error"; output?: unknown; usage?: Usage; error?: string; model?: string }
  | { t: "done" }
  | { t: "error"; message: string };

/** Applies one streamed event to a span list. Pure, so the UI and tests share it. */
export function applyEvent(spans: Span[], e: RunEvent): Span[] {
  switch (e.t) {
    case "span_start":
      return [...spans, e.span];
    case "span_delta":
      return spans.map((s) => (s.id === e.id ? { ...s, output: String(s.output ?? "") + e.text } : s));
    case "span_end":
      return spans.map((s) =>
        s.id === e.id
          ? {
              ...s,
              end: e.end,
              status: e.status,
              output: e.output ?? s.output,
              usage: e.usage ?? s.usage,
              error: e.error,
              model: e.model ?? s.model,
            }
          : s,
      );
    default:
      return spans;
  }
}
