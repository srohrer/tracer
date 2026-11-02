"use client";

import clsx from "clsx";
import { Download, Pause, Play, RotateCcw, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { atTime, formatMs, formatTokens, formatUsd, runDuration, runStats } from "@/lib/analysis";
import { useActiveRun, useStore } from "@/lib/store";
import type { Run } from "@/lib/trace";
import { Overview } from "./Overview";
import { SpanDetail } from "./SpanDetail";
import { Waterfall } from "./Waterfall";

function useNow(active: boolean, startedAt: number | undefined): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    const id = setInterval(() => setNow(Date.now() - startedAt), 100);
    return () => clearInterval(id);
  }, [active, startedAt]);
  return now;
}

function usePlaybackClock(duration: number) {
  const t = useStore((s) => s.playback.t);
  const playing = useStore((s) => s.playback.playing);
  const speed = useStore((s) => s.playback.speed);
  const setPlayback = useStore((s) => s.setPlayback);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const id = setInterval(() => {
      const nowMs = performance.now();
      const dt = (nowMs - last) * speed;
      last = nowMs;
      const cur = useStore.getState().playback.t ?? 0;
      if (cur + dt >= duration) setPlayback({ t: null, playing: false });
      else setPlayback({ t: cur + dt });
    }, 50);
    return () => clearInterval(id);
  }, [playing, speed, duration, setPlayback]);
  return t;
}

function PlaybackBar({ duration }: { duration: number }) {
  const t = usePlaybackClock(duration);
  const playing = useStore((s) => s.playback.playing);
  const speed = useStore((s) => s.playback.speed);
  const setPlayback = useStore((s) => s.setPlayback);
  const shown = t ?? duration;
  const btn = "flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-text";
  return (
    <div className="flex items-center gap-2">
      <button
        className={btn}
        aria-label={playing ? "Pause replay" : "Play replay"}
        onClick={() => (playing ? setPlayback({ playing: false }) : setPlayback({ playing: true, t: t ?? 0 }))}
      >
        {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
      </button>
      <button className={btn} aria-label="Show the full run" title="Show the full run" onClick={() => setPlayback({ t: null, playing: false })}>
        <RotateCcw className="size-3.5" />
      </button>
      <input
        type="range"
        aria-label="Scrub through the run"
        min={0}
        max={duration}
        step={10}
        value={shown}
        onChange={(e) => setPlayback({ t: Number(e.target.value), playing: false })}
        className="min-w-0 flex-1"
      />
      <span className="w-28 shrink-0 text-right font-mono text-[11px] text-muted tabular-nums">
        {formatMs(shown)} / {formatMs(duration)}
      </span>
      <select
        aria-label="Replay speed"
        value={speed}
        onChange={(e) => setPlayback({ speed: Number(e.target.value) })}
        className="shrink-0 rounded-md border border-border bg-panel px-1 py-1 font-mono text-[11px] text-muted"
      >
        {[1, 2, 5].map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bad" }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-panel px-3 py-2">
      <div className="text-[10px] text-faint uppercase">{label}</div>
      <div className={clsx("font-mono text-sm font-medium tabular-nums", tone === "bad" && "text-bad")}>{value}</div>
      {sub && <div className="truncate font-mono text-[10px] text-faint">{sub}</div>}
    </div>
  );
}

function exportRun(run: Run) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${run.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.trace.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function TraceView() {
  const run = useActiveRun();
  const streaming = useStore((s) => s.streaming);
  const selectedId = useStore((s) => s.selectedId);
  const playhead = useStore((s) => s.playback.t);
  const range = useStore((s) => s.range);
  const setRange = useStore((s) => s.setRange);
  const live = Boolean(run && streaming?.id === run.id);
  const liveNow = useNow(live, streaming?.startedAt);

  const fullDuration = useMemo(() => (run ? runDuration(run) : 0), [run]);
  const spans = useMemo(() => {
    if (!run) return [];
    return playhead !== null ? atTime(run.spans, playhead) : run.spans;
  }, [run, playhead]);

  if (!run) return <div className="flex h-full items-center justify-center text-sm text-faint">No runs yet.</div>;

  const now = live ? liveNow : (playhead ?? fullDuration);
  const duration = live ? Math.max(liveNow, fullDuration) : fullDuration;
  const s = runStats({ spans }, now);
  const modelShare = s.duration ? Math.round((s.activeMs.llm / s.duration) * 100) : 0;
  const selected = spans.find((x) => x.id === selectedId);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 sm:p-4 xl:overflow-hidden">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{run.name}</h1>
          {(run.task || run.note) && <p className="truncate text-xs text-muted" title={run.task}>{run.note ?? run.task}</p>}
        </div>
        {range && (
          <button onClick={() => setRange(null)} className="flex shrink-0 items-center gap-1 text-xs text-muted hover:text-text">
            <ZoomOut className="size-3.5" /> Reset zoom
          </button>
        )}
        <button onClick={() => exportRun(run)} disabled={live} className="flex shrink-0 items-center gap-1 text-xs text-muted hover:text-text disabled:opacity-40">
          <Download className="size-3.5" /> Export
        </button>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Duration" value={formatMs(s.duration)} sub={`${modelShare}% in the model`} />
        <Stat label="Calls" value={String(s.llmCalls + s.toolCalls)} sub={`${s.llmCalls} model · ${s.toolCalls} tool`} />
        <Stat label="Tokens" value={formatTokens(s.inputTokens + s.outputTokens)} sub={`${formatTokens(s.inputTokens)} in · ${formatTokens(s.outputTokens)} out`} />
        <Stat label="Est. cost" value={formatUsd(s.cost)} sub={run.model} />
        <Stat label="Errors" value={String(s.errors)} tone={s.errors ? "bad" : undefined} sub={s.errors ? "click a red span" : "none"} />
      </div>

      <Overview spans={run.spans} now={now} duration={duration} />
      {!live && <PlaybackBar duration={fullDuration} />}

      <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="h-[440px] min-w-0 xl:h-auto xl:min-h-0">
          <Waterfall spans={spans} now={now} duration={duration} />
        </div>
        <div className="h-[420px] min-w-0 rounded-xl border border-border bg-panel xl:h-auto xl:min-h-0">
          <SpanDetail span={selected} now={now} />
        </div>
      </div>

      <div className="hidden items-center gap-4 text-[10px] text-faint sm:flex">
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-llm" /> model</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-tool" /> tool</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-bad" /> failed</span>
        <span className="ml-auto">Drag the overview to zoom · ⌘/Ctrl+scroll zooms · Shift+scroll pans · arrow keys move between spans</span>
      </div>
    </div>
  );
}
