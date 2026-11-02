import { RunSchema, type Run, type Span, type SpanKind } from "./trace";

/**
 * Imports traces from Tracer's own export format or from OpenTelemetry's OTLP/JSON,
 * mapping the GenAI semantic conventions (gen_ai.*) onto spans.
 */

interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string | number;
  endTimeUnixNano?: string | number;
  status?: { code?: number | string; message?: string };
  attributes?: { key: string; value: OtlpValue }[];
}
interface OtlpDoc {
  resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[];
}

function attrValue(v: OtlpValue): string | number | boolean | undefined {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  return v.boolValue;
}

function kindOf(attrs: Record<string, unknown>): SpanKind {
  const op = attrs["gen_ai.operation.name"];
  if (op === "execute_tool" || attrs["gen_ai.tool.name"] !== undefined) return "tool";
  if (op === "chat" || op === "text_completion" || op === "generate_content" || attrs["gen_ai.usage.input_tokens"] !== undefined) {
    return "llm";
  }
  return "agent";
}

/** Nanosecond timestamps exceed 2^53, so convert relative to the trace start with BigInt. */
const nanos = (v: string | number) => BigInt(typeof v === "number" ? Math.trunc(v) : v);
const relMs = (v: string | number, base: bigint) => Number(nanos(v) - base) / 1e6;

function isError(status: OtlpSpan["status"]): boolean {
  return status?.code === 2 || status?.code === "STATUS_CODE_ERROR";
}

function parseOtlp(doc: OtlpDoc, fileName: string): Run[] {
  const all = (doc.resourceSpans ?? []).flatMap((r) => (r.scopeSpans ?? []).flatMap((s) => s.spans ?? []));
  if (!all.length) throw new Error("This OTLP file has no spans.");
  const traces = new Map<string, OtlpSpan[]>();
  for (const s of all) traces.set(s.traceId, [...(traces.get(s.traceId) ?? []), s]);

  return [...traces.entries()].map(([traceId, spans]) => {
    const base = spans.map((s) => nanos(s.startTimeUnixNano)).reduce((a, b) => (b < a ? b : a));
    const mapped: Span[] = spans.map((s) => {
      const attrs = Object.fromEntries((s.attributes ?? []).map((a) => [a.key, attrValue(a.value)]));
      const input = attrs["gen_ai.usage.input_tokens"] ?? attrs["gen_ai.usage.prompt_tokens"];
      const output = attrs["gen_ai.usage.output_tokens"] ?? attrs["gen_ai.usage.completion_tokens"];
      const failed = isError(s.status);
      return {
        id: s.spanId,
        parentId: s.parentSpanId || null,
        kind: kindOf(attrs),
        name: s.name,
        start: relMs(s.startTimeUnixNano, base),
        end: s.endTimeUnixNano ? relMs(s.endTimeUnixNano, base) : null,
        status: failed ? "error" : s.endTimeUnixNano ? "ok" : "running",
        model: (attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"]) as string | undefined,
        usage: typeof input === "number" && typeof output === "number" ? { input, output } : undefined,
        input: attrs,
        error: failed ? (s.status?.message ?? "error") : undefined,
      };
    });
    const root = mapped.find((s) => !s.parentId);
    return {
      id: `otlp:${traceId}:${crypto.randomUUID()}`,
      name: root?.name ?? fileName,
      createdAt: new Date().toISOString(),
      source: "imported" as const,
      note: `Imported from ${fileName} (OTLP)`,
      spans: mapped,
    };
  });
}

/** Detects the format of an uploaded trace file and returns the runs inside it. */
export function parseTraceFile(text: string, fileName: string): Run[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${fileName} isn't valid JSON.`);
  }
  if (doc && typeof doc === "object" && "resourceSpans" in doc) return parseOtlp(doc as OtlpDoc, fileName);

  const parsed = RunSchema.safeParse(doc);
  if (!parsed.success) throw new Error(`${fileName} isn't a Tracer export or OTLP/JSON trace.`);
  return [{ ...parsed.data, id: `import:${crypto.randomUUID()}`, source: "imported", note: `Imported from ${fileName}` }];
}
