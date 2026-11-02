"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { flatten, formatMs, formatTokens, niceStep, type Row } from "@/lib/analysis";
import { useStore } from "@/lib/store";
import type { Span } from "@/lib/trace";

const ROW_H = 30;

export const barClass = (s: Span) =>
  s.status === "error" ? "bg-bad/85" : s.kind === "llm" ? "bg-llm/85" : s.kind === "tool" ? "bg-tool/85" : "bg-agent";

const MIN_WINDOW_MS = 50;

export function Waterfall({ spans, now, duration }: { spans: Span[]; now: number; duration: number }) {
  const selectedId = useStore((s) => s.selectedId);
  const selectSpan = useStore((s) => s.selectSpan);
  const collapsed = useStore((s) => s.collapsed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const range = useStore((s) => s.range);
  const setRange = useStore((s) => s.setRange);
  const playhead = useStore((s) => s.playback.t);

  const rows = useMemo(() => flatten(spans, collapsed), [spans, collapsed]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const total = Math.max(duration, 1);
  const [a, b] = range ?? [0, total];
  const pct = (t: number) => ((t - a) / (b - a)) * 100;

  // eslint-disable-next-line react-hooks/incompatible-library -- virtualizer state is read fresh each render
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  // Tick density follows the track's real width so labels never collide.
  const [trackWidth, setTrackWidth] = useState(500);
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl/⌘+scroll zooms around the cursor; shift+scroll pans in time.
  const view = useRef({ a, b, total });
  useEffect(() => {
    view.current = { a, b, total };
  }, [a, b, total]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
      e.preventDefault();
      const { a, b, total } = view.current;
      const width = b - a;
      if (e.shiftKey) {
        const shift = (width * (e.deltaY || e.deltaX)) / 800;
        const from = Math.min(Math.max(0, a + shift), total - width);
        setRange(width >= total ? null : [from, from + width]);
        return;
      }
      const box = timelineRef.current?.getBoundingClientRect();
      const frac = box ? Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) : 0.5;
      const next = Math.min(total, Math.max(MIN_WINDOW_MS, width * Math.exp(e.deltaY * 0.005)));
      if (next >= total) return setRange(null);
      const from = Math.min(Math.max(0, a + (width - next) * frac), total - next);
      setRange([from, from + next]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setRange]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.span.id === selectedId);
    const row: Row | undefined = rows[i];
    let next = i;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "ArrowLeft" && row?.hasChildren && !collapsed.has(row.span.id)) toggleCollapsed(row.span.id);
    else if (e.key === "ArrowRight" && row?.hasChildren && collapsed.has(row.span.id)) toggleCollapsed(row.span.id);
    else return;
    e.preventDefault();
    if (next !== i && rows[next]) {
      selectSpan(rows[next].span.id);
      virtualizer.scrollToIndex(next);
    }
  };

  const step = niceStep(b - a, Math.max(2, Math.floor(trackWidth / 90)));
  const ticks: number[] = [];
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) ticks.push(t);
  const headPos = playhead !== null ? pct(playhead) : null;

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="Span timeline"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative h-full overflow-y-auto rounded-xl border border-border bg-panel text-xs outline-none focus-visible:border-accent/50"
    >
      <div className="sticky top-0 z-20 grid h-7 grid-cols-[132px_1fr] border-b border-border bg-panel-2 sm:grid-cols-[230px_1fr]">
        <div className="flex items-center px-3 text-[10px] font-semibold tracking-wider text-faint uppercase">Span</div>
        <div ref={timelineRef} className="relative overflow-hidden">
          {ticks.map((t) => (
            <span key={t} className="absolute top-1.5 pl-1 font-mono text-[10px] text-faint" style={{ left: `${pct(t)}%` }}>
              {t >= 1000 ? `${+(t / 1000).toFixed(2)}s` : `${Math.round(t)}ms`}
            </span>
          ))}
        </div>
      </div>

      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        <div className="pointer-events-none absolute inset-0 grid grid-cols-[132px_1fr] sm:grid-cols-[230px_1fr]">
          <div />
          <div className="relative overflow-hidden">
            {ticks.map((t) => (
              <div key={t} className="absolute inset-y-0 border-l border-border/50" style={{ left: `${pct(t)}%` }} />
            ))}
            {headPos !== null && headPos >= 0 && headPos <= 100 && (
              <div className="absolute inset-y-0 z-10 w-px bg-accent" style={{ left: `${headPos}%` }} />
            )}
          </div>
        </div>

        {virtualizer.getVirtualItems().map((v) => {
          const { span, depth, hasChildren } = rows[v.index];
          const selected = span.id === selectedId;
          const end = span.end ?? now;
          const left = Math.max(0, pct(span.start));
          const right = Math.min(100, pct(end));
          const visible = right > 0 && left < 100;
          const running = span.status === "running";
          return (
            <div
              key={span.id}
              role="treeitem"
              aria-selected={selected}
              aria-expanded={hasChildren ? !collapsed.has(span.id) : undefined}
              onClick={() => selectSpan(span.id)}
              className={clsx(
                "absolute left-0 grid w-full cursor-pointer grid-cols-[132px_1fr] border-b border-border/40 sm:grid-cols-[230px_1fr]",
                selected ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
              )}
              style={{ height: ROW_H, transform: `translateY(${v.start}px)` }}
            >
              <div className="flex min-w-0 items-center gap-1 pr-2" style={{ paddingLeft: 6 + depth * 12 }}>
                {hasChildren ? (
                  <button
                    aria-label={collapsed.has(span.id) ? "Expand" : "Collapse"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapsed(span.id);
                    }}
                    className="shrink-0 rounded text-faint hover:text-text"
                  >
                    <ChevronRight className={clsx("size-3.5 transition-transform", !collapsed.has(span.id) && "rotate-90")} />
                  </button>
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className={clsx("truncate font-mono text-[11px]", span.status === "error" ? "text-bad" : span.kind === "agent" ? "text-text" : "text-muted")}>
                  {span.name}
                </span>
                {span.status === "error" && <CircleAlert className="size-3 shrink-0 text-bad" aria-label="failed" />}
              </div>
              <div className="relative overflow-hidden">
                {visible && (
                  <div
                    className={clsx("absolute top-1.5 h-[18px] min-w-0.5 rounded-sm", barClass(span), running && "animate-pulse", selected && "ring-1 ring-white/70")}
                    style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
                  />
                )}
                {visible && !running && right < 88 && span.kind !== "agent" && (
                  <span className="absolute top-2 pl-1 font-mono text-[10px] whitespace-nowrap text-faint" style={{ left: `${right}%` }}>
                    {formatMs(end - span.start)}
                    {span.usage && ` · ${formatTokens(span.usage.input + span.usage.output)} tok`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
