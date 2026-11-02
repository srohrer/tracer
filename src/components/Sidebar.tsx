"use client";

import clsx from "clsx";
import { Play, Square, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { DEFAULT_TASK } from "@/lib/agent/incident";
import { formatMs, formatUsd, runStats } from "@/lib/analysis";
import { useStore } from "@/lib/store";

export function Sidebar({ onPick }: { onPick?: () => void }) {
  const runs = useStore((s) => s.runs);
  const activeId = useStore((s) => s.activeId);
  const view = useStore((s) => s.view);
  const selectRun = useStore((s) => s.selectRun);
  const streaming = useStore((s) => s.streaming);
  const liveAvailable = useStore((s) => s.liveAvailable);
  const startRun = useStore((s) => s.startRun);
  const stopRun = useStore((s) => s.stopRun);
  const importFile = useStore((s) => s.importFile);
  const [task, setTask] = useState(DEFAULT_TASK);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <aside className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">Run the agent</h2>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          maxLength={500}
          rows={4}
          disabled={!liveAvailable}
          aria-label="Task for the agent"
          className="w-full resize-none rounded-lg border border-border bg-panel-2 p-2.5 text-xs leading-relaxed outline-none focus:border-accent/60 disabled:opacity-50"
        />
        {streaming ? (
          <button onClick={stopRun} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-bad/50 py-2 text-xs font-medium text-bad hover:bg-bad/10">
            <Square className="size-3 fill-current" /> Stop run
          </button>
        ) : (
          <button
            onClick={() => {
              startRun(task.trim());
              onPick?.();
            }}
            disabled={!liveAvailable || !task.trim()}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-xs font-semibold text-bg hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play className="size-3 fill-current" /> Start live run
          </button>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          {liveAvailable
            ? "A real DeepSeek agent investigates a fictional outage. The model calls are real; the tools and their latency are simulated."
            : "Live runs aren't enabled here. The recorded runs below are real DeepSeek runs against simulated tools."}
        </p>
      </section>

      <section className="min-h-0">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold tracking-wider text-faint uppercase">Runs</h2>
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 text-[11px] text-muted hover:text-text" title="Tracer export or OpenTelemetry OTLP/JSON">
            <Upload className="size-3" /> Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            aria-label="Import trace file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f).then(() => onPick?.());
              e.target.value = "";
            }}
          />
        </div>
        <ul className="space-y-1">
          {runs.map((r) => {
            const s = runStats(r);
            const live = streaming?.id === r.id;
            return (
              <li key={r.id}>
                <button
                  onClick={() => {
                    selectRun(r.id);
                    onPick?.();
                  }}
                  className={clsx(
                    "w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
                    r.id === activeId && view === "trace" ? "border-accent/40 bg-panel-2" : "border-transparent hover:bg-panel-2",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className={clsx("size-1.5 shrink-0 rounded-full", live ? "animate-pulse bg-accent" : s.errors ? "bg-bad" : "bg-ok")} />
                    <span className="truncate text-xs font-medium">{r.name}</span>
                  </span>
                  <span className="mt-1 block pl-3.5 font-mono text-[10px] text-faint">
                    {r.source} · {live ? "running" : `${formatMs(s.duration)} · ${formatUsd(s.cost)}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
