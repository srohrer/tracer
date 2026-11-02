"use client";

import clsx from "clsx";
import { useMemo } from "react";
import { diffRuns, formatMs, formatTokens, formatUsd, runDuration, runStats, signed, type DiffRow } from "@/lib/analysis";
import { useStore } from "@/lib/store";
import type { Run, Span } from "@/lib/trace";
import { barClass } from "./Waterfall";

function RunSelect({ label, value, runs, onChange }: { label: string; value: string; runs: Run[]; onChange: (id: string) => void }) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted">
      <span className="shrink-0 font-mono font-semibold text-text">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-panel px-2 py-1.5 text-xs text-text">
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Lower is better for every metric here, so an increase reads as a regression. */
function Delta({ label, a, b, fmt }: { label: string; a: number; b: number; fmt: (n: number) => string }) {
  const d = b - a;
  const pct = a ? Math.round((d / a) * 100) : null;
  return (
    <div className="min-w-0 rounded-lg border border-border bg-panel px-3 py-2">
      <div className="text-[10px] text-faint uppercase">{label}</div>
      <div className="font-mono text-[11px] text-muted tabular-nums">
        {fmt(a)} → <span className="text-text">{fmt(b)}</span>
      </div>
      <div className={clsx("font-mono text-xs font-medium tabular-nums", d > 0 ? "text-bad" : d < 0 ? "text-ok" : "text-faint")}>
        {d === 0 ? "no change" : `${signed(d, fmt)}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}`}
      </div>
    </div>
  );
}

function Bar({ span, total }: { span?: Span; total: number }) {
  return (
    <div className="relative h-4 min-w-0 rounded-sm bg-white/[0.02]">
      {span && (
        <div
          className={clsx("absolute inset-y-0.5 min-w-0.5 rounded-sm", barClass(span))}
          style={{ left: `${(span.start / total) * 100}%`, width: `${(((span.end ?? span.start) - span.start) / total) * 100}%` }}
        />
      )}
    </div>
  );
}

const ROW_TINT: Record<DiffRow["kind"], string> = {
  same: "",
  changed: "",
  added: "bg-ok/[0.07]",
  removed: "bg-bad/[0.07]",
};

const MARK: Record<DiffRow["kind"], string> = { same: " ", changed: "~", added: "+", removed: "−" };

export function CompareView() {
  const runs = useStore((s) => s.runs);
  const compare = useStore((s) => s.compare);
  const setCompare = useStore((s) => s.setCompare);
  const a = runs.find((r) => r.id === compare.a) ?? runs[0];
  const b = runs.find((r) => r.id === compare.b) ?? runs[1] ?? runs[0];

  const diff = useMemo(() => (a && b ? diffRuns(a, b) : null), [a, b]);
  if (!a || !b || !diff) return <div className="flex h-full items-center justify-center text-sm text-faint">Nothing to compare yet.</div>;

  const sa = runStats(a);
  const sb = runStats(b);
  const total = Math.max(runDuration(a), runDuration(b), 1);
  const cols = "grid-cols-[minmax(110px,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_58px] sm:grid-cols-[minmax(170px,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_70px_70px]";

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <RunSelect label="A" value={a.id} runs={runs} onChange={(id) => setCompare({ a: id })} />
        <RunSelect label="B" value={b.id} runs={runs} onChange={(id) => setCompare({ b: id })} />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Delta label="Duration" a={sa.duration} b={sb.duration} fmt={formatMs} />
        <Delta label="Tokens" a={sa.inputTokens + sa.outputTokens} b={sb.inputTokens + sb.outputTokens} fmt={formatTokens} />
        <Delta label="Est. cost" a={sa.cost} b={sb.cost} fmt={formatUsd} />
        <Delta label="Errors" a={sa.errors} b={sb.errors} fmt={String} />
      </div>

      <p className="text-xs text-muted">
        <span className="text-ok">{diff.added} added</span> · <span className="text-bad">{diff.removed} removed</span> · {diff.changed} changed. Spans are aligned by what they are, in timeline order, so you can see where two runs took different paths.
      </p>

      <div className="min-w-0 rounded-xl border border-border bg-panel text-xs">
        <div className={clsx("sticky top-0 z-10 grid gap-2 rounded-t-xl border-b border-border bg-panel-2 px-3 py-1.5 text-[10px] font-semibold tracking-wider text-faint uppercase", cols)}>
          <span>Span</span>
          <span>A</span>
          <span>B</span>
          <span className="text-right">Δ time</span>
          <span className="hidden text-right sm:block">Δ tokens</span>
        </div>
        <ol>
          {diff.rows.map((r, i) => {
            const span = (r.b ?? r.a)!;
            return (
              <li key={i} className={clsx("grid items-center gap-2 border-b border-border/40 px-3 py-1", cols, ROW_TINT[r.kind])}>
                <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: r.depth * 10 }}>
                  <span className={clsx("w-2.5 shrink-0 font-mono", r.kind === "added" ? "text-ok" : r.kind === "removed" ? "text-bad" : "text-tool")}>{MARK[r.kind]}</span>
                  <span className="truncate font-mono text-[11px] text-muted">{span.name}</span>
                  {r.statusChanged && <span className="shrink-0 rounded bg-bad/15 px-1 text-[9px] text-bad">status</span>}
                </span>
                <Bar span={r.a} total={total} />
                <Bar span={r.b} total={total} />
                <span className={clsx("text-right font-mono text-[10px] tabular-nums", !r.durationDelta ? "text-faint" : r.durationDelta > 0 ? "text-bad" : "text-ok")}>
                  {r.durationDelta === undefined ? "" : signed(r.durationDelta, formatMs)}
                </span>
                <span className={clsx("hidden text-right font-mono text-[10px] tabular-nums sm:block", !r.tokenDelta ? "text-faint" : r.tokenDelta > 0 ? "text-bad" : "text-ok")}>
                  {r.tokenDelta ? signed(r.tokenDelta, formatTokens) : ""}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
