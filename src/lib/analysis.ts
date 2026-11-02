import type { Run, Span, SpanKind } from "./trace";

/** USD per 1M tokens: DeepSeek list prices at peak, the conservative estimate. */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "deepseek-flash": { input: 0.3, cached: 0.006, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, cached: 0.044, output: 3.96 },
};

export function spanCost(span: Span): number {
  if (!span.usage) return 0;
  const key = Object.keys(PRICES).find((k) => span.model?.startsWith(k));
  if (!key) return 0;
  const p = PRICES[key];
  const cached = span.usage.cached ?? 0;
  return (Math.max(0, span.usage.input - cached) * p.input + cached * p.cached + span.usage.output * p.output) / 1e6;
}

export const spanEnd = (s: Span, now: number) => s.end ?? now;

/** End of the last finished or running span, i.e. the length of the timeline. */
export function runDuration(run: Pick<Run, "spans">, now = 0): number {
  return run.spans.reduce((m, s) => Math.max(m, s.end ?? Math.max(now, s.start)), 0);
}

export interface Row {
  span: Span;
  depth: number;
  hasChildren: boolean;
}

/** Depth-first flattening of the span tree, skipping children of collapsed spans. */
export function flatten(spans: Span[], collapsed: ReadonlySet<string> = new Set()): Row[] {
  const ids = new Set(spans.map((s) => s.id));
  const children = new Map<string | null, Span[]>();
  for (const s of spans) {
    // orphans (parent missing from an import) are promoted to roots rather than dropped
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    const list = children.get(parent);
    if (list) list.push(s);
    else children.set(parent, [s]);
  }
  for (const list of children.values()) list.sort((a, b) => a.start - b.start);

  const rows: Row[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      const hasChildren = children.has(span.id);
      rows.push({ span, depth, hasChildren });
      if (hasChildren && !collapsed.has(span.id)) visit(span.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

export interface RunStats {
  duration: number;
  spans: number;
  llmCalls: number;
  toolCalls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  /** wall-clock ms during which at least one span of that kind was running */
  activeMs: Record<Exclude<SpanKind, "agent">, number>;
}

/** Length of the union of intervals, so parallel tool calls aren't double counted. */
function unionLength(intervals: [number, number][]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [a, b] of sorted) {
    const from = Math.max(a, cursor);
    if (b > from) {
      total += b - from;
      cursor = b;
    }
  }
  return total;
}

export function runStats(run: Pick<Run, "spans">, now = 0): RunStats {
  const { spans } = run;
  const intervals = (kind: SpanKind) =>
    spans.filter((s) => s.kind === kind).map((s): [number, number] => [s.start, spanEnd(s, now)]);
  return {
    duration: runDuration(run, now),
    spans: spans.length,
    llmCalls: spans.filter((s) => s.kind === "llm").length,
    toolCalls: spans.filter((s) => s.kind === "tool").length,
    errors: spans.filter((s) => s.status === "error").length,
    inputTokens: spans.reduce((n, s) => n + (s.usage?.input ?? 0), 0),
    outputTokens: spans.reduce((n, s) => n + (s.usage?.output ?? 0), 0),
    cachedTokens: spans.reduce((n, s) => n + (s.usage?.cached ?? 0), 0),
    cost: spans.reduce((n, s) => n + spanCost(s), 0),
    activeMs: { llm: unionLength(intervals("llm")), tool: unionLength(intervals("tool")) },
  };
}

/**
 * The run as it looked at time t, for replay: spans that hadn't started are gone,
 * running ones are unfinished, and usage only counts once a call has completed.
 */
export function atTime(spans: Span[], t: number): Span[] {
  return spans
    .filter((s) => s.start <= t)
    .map((s) =>
      s.end === null || s.end <= t ? s : { ...s, end: null, status: "running" as const, usage: undefined, error: undefined, output: undefined },
    );
}

// ---------------------------------------------------------------------------
// Run-to-run diff

export type DiffKind = "same" | "changed" | "added" | "removed";

export interface DiffRow {
  kind: DiffKind;
  depth: number;
  a?: Span;
  b?: Span;
  /** ms, b minus a */
  durationDelta?: number;
  tokenDelta?: number;
  statusChanged?: boolean;
}

export interface RunDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  changed: number;
}

const duration = (s: Span) => (s.end ?? s.start) - s.start;
const tokens = (s: Span) => (s.usage?.input ?? 0) + (s.usage?.output ?? 0);

/** Agent steps are numbered, which would misalign runs that take a different path. */
const signature = (s: Span) => `${s.kind}:${s.name.replace(/\s*\d+$/, "")}`;

/** Timing differences under this are noise, not a change worth flagging. */
const CHANGED_RATIO = 0.25;
const CHANGED_MIN_MS = 150;

function isChanged(a: Span, b: Span): boolean {
  if (a.status !== b.status) return true;
  const d = Math.abs(duration(b) - duration(a));
  return d >= CHANGED_MIN_MS && d >= CHANGED_RATIO * Math.max(duration(a), 1);
}

/** Aligns two runs in timeline order with a longest-common-subsequence on span identity. */
export function diffRuns(a: Pick<Run, "spans">, b: Pick<Run, "spans">): RunDiff {
  const ra = flatten(a.spans);
  const rb = flatten(b.spans);
  const n = ra.length;
  const m = rb.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        signature(ra[i].span) === signature(rb[j].span) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && signature(ra[i].span) === signature(rb[j].span)) {
      const x = ra[i].span;
      const y = rb[j].span;
      rows.push({
        kind: isChanged(x, y) ? "changed" : "same",
        depth: rb[j].depth,
        a: x,
        b: y,
        durationDelta: duration(y) - duration(x),
        tokenDelta: tokens(y) - tokens(x),
        statusChanged: x.status !== y.status,
      });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      rows.push({ kind: "added", depth: rb[j].depth, b: rb[j].span });
      j++;
    } else {
      rows.push({ kind: "removed", depth: ra[i].depth, a: ra[i].span });
      i++;
    }
  }
  return {
    rows,
    added: rows.filter((r) => r.kind === "added").length,
    removed: rows.filter((r) => r.kind === "removed").length,
    changed: rows.filter((r) => r.kind === "changed").length,
  };
}

// ---------------------------------------------------------------------------
// Formatting

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
}

export function signed(n: number, fmt: (v: number) => string): string {
  return `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
}

/** Round-number tick spacing for a time axis, aiming for about `count` ticks. */
export function niceStep(span: number, count = 6): number {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-3)));
  const unit = raw / pow;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * pow;
}
