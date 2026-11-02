"use client";

import { useMemo, useRef, useState } from "react";
import { flatten } from "@/lib/analysis";
import { useStore } from "@/lib/store";
import type { Span } from "@/lib/trace";

const FILL = { llm: "var(--llm)", tool: "var(--tool)", agent: "var(--agent)" };

/** A compressed view of the whole run. Drag across it to zoom the timeline. */
export function Overview({ spans, now, duration }: { spans: Span[]; now: number; duration: number }) {
  const range = useStore((s) => s.range);
  const setRange = useStore((s) => s.setRange);
  const playhead = useStore((s) => s.playback.t);
  const rows = useMemo(() => flatten(spans).filter((r) => r.depth > 0 || spans.length === 1), [spans]);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const total = Math.max(duration, 1);

  const toTime = (clientX: number) => {
    const box = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * total;
  };

  const shown = drag ? ([Math.min(...drag), Math.max(...drag)] as const) : range;
  const rowH = 100 / Math.max(rows.length, 1);

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Zoom window. Drag to zoom, double-click to reset."
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((((shown?.[1] ?? total) - (shown?.[0] ?? 0)) / total) * 100)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const t = toTime(e.clientX);
        setDrag([t, t]);
      }}
      onPointerMove={(e) => drag && setDrag([drag[0], toTime(e.clientX)])}
      onPointerUp={() => {
        if (!drag) return;
        const [x, y] = [Math.min(...drag), Math.max(...drag)];
        setDrag(null);
        // a plain click isn't a zoom; ignore tiny drags
        if (y - x > total * 0.01) setRange([x, y]);
      }}
      onDoubleClick={() => setRange(null)}
      className="relative h-12 cursor-crosshair touch-none overflow-hidden rounded-lg border border-border bg-panel select-none"
    >
      <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {rows.map(({ span }, i) => (
          <rect
            key={span.id}
            x={(span.start / total) * 100}
            y={i * rowH}
            width={Math.max(0.2, (((span.end ?? now) - span.start) / total) * 100)}
            height={Math.max(rowH * 0.8, 1)}
            fill={span.status === "error" ? "var(--bad)" : FILL[span.kind]}
            opacity={0.85}
          />
        ))}
      </svg>
      {shown && (
        <>
          <div className="absolute inset-y-0 left-0 bg-black/60" style={{ width: `${(shown[0] / total) * 100}%` }} />
          <div className="absolute inset-y-0 right-0 bg-black/60" style={{ width: `${100 - (shown[1] / total) * 100}%` }} />
          <div className="absolute inset-y-0 border-x border-accent" style={{ left: `${(shown[0] / total) * 100}%`, width: `${((shown[1] - shown[0]) / total) * 100}%` }} />
        </>
      )}
      {playhead !== null && <div className="absolute inset-y-0 w-px bg-accent" style={{ left: `${(playhead / total) * 100}%` }} />}
    </div>
  );
}
