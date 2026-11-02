"use client";

import { create } from "zustand";
import recorded from "@/runs/recorded.json";
import { flatten } from "./analysis";
import { parseTraceFile } from "./importers";
import { applyEvent, type Run, type RunEvent } from "./trace";

const RECORDED = recorded as Run[];

export interface Playback {
  /** null means the full run is shown */
  t: number | null;
  playing: boolean;
  speed: number;
}

interface State {
  runs: Run[];
  activeId: string;
  view: "trace" | "compare";
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  /** zoom window in ms; null shows the whole run */
  range: [number, number] | null;
  playback: Playback;
  compare: { a: string; b: string };
  liveAvailable: boolean;
  /** id of the run currently streaming, and when it started */
  streaming: { id: string; startedAt: number } | null;
  error: string | null;

  init(): void;
  selectRun(id: string): void;
  setView(v: State["view"]): void;
  selectSpan(id: string | null): void;
  toggleCollapsed(id: string): void;
  setRange(r: [number, number] | null): void;
  setPlayback(p: Partial<Playback>): void;
  setCompare(c: Partial<State["compare"]>): void;
  startRun(task: string): Promise<void>;
  stopRun(): void;
  importFile(file: File): Promise<void>;
  dismissError(): void;
}

let controller: AbortController | null = null;

const freshRunState = (run: Run | undefined) => ({
  activeId: run?.id ?? "",
  selectedId: run ? (flatten(run.spans)[0]?.span.id ?? null) : null,
  collapsed: new Set<string>(),
  range: null,
  playback: { t: null, playing: false, speed: 2 },
});

export const useStore = create<State>((set, get) => ({
  runs: RECORDED,
  ...freshRunState(RECORDED[0]),
  view: "trace",
  compare: { a: RECORDED[0]?.id ?? "", b: RECORDED[1]?.id ?? "" },
  liveAvailable: false,
  streaming: null,
  error: null,

  init() {
    fetch("/api/status")
      .then((r) => r.json())
      .then((s: { live: boolean }) => set({ liveAvailable: s.live }))
      .catch(() => {});
    // Open by replaying the first run, unless the visitor prefers no motion.
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      set({ playback: { t: 0, playing: true, speed: 2 } });
    }
  },

  selectRun(id) {
    set({ ...freshRunState(get().runs.find((r) => r.id === id)), view: "trace" });
  },
  setView: (view) => set({ view }),
  selectSpan: (selectedId) => set({ selectedId }),
  toggleCollapsed(id) {
    const next = new Set(get().collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ collapsed: next });
  },
  setRange: (range) => set({ range }),
  setPlayback: (p) => set((s) => ({ playback: { ...s.playback, ...p } })),
  setCompare: (c) => set((s) => ({ compare: { ...s.compare, ...c } })),

  async startRun(task) {
    if (get().streaming) return;
    const run: Run = {
      id: `live:${crypto.randomUUID()}`,
      name: task.length > 48 ? `${task.slice(0, 48)}…` : task,
      task,
      model: "deepseek-flash",
      createdAt: new Date().toISOString(),
      source: "live",
      note: "A live run. The first metrics call is made to fail, so the agent has to recover.",
      spans: [],
    };
    controller = new AbortController();
    set((s) => ({
      runs: [run, ...s.runs],
      ...freshRunState(run),
      view: "trace",
      streaming: { id: run.id, startedAt: Date.now() },
    }));

    const apply = (e: RunEvent) =>
      set((s) => {
        const runs = s.runs.map((r) => (r.id === run.id ? { ...r, spans: applyEvent(r.spans, e) } : r));
        const selected = s.activeId === run.id && !s.selectedId ? (runs.find((r) => r.id === run.id)?.spans[0]?.id ?? null) : s.selectedId;
        return { runs, selectedId: selected };
      });

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `The run failed (${res.status}).`);
      }
      const reader = res.body.getReader();
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
          if (!line) continue;
          const e = JSON.parse(line) as RunEvent;
          if (e.t === "error") throw new Error(e.message);
          apply(e);
        }
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      if (!aborted) set({ error: e instanceof Error ? e.message : "The run failed." });
      // Close anything still open so a dead stream can't look like it's running forever.
      const end = Date.now() - (get().streaming?.startedAt ?? Date.now());
      set((s) => ({
        runs: s.runs.map((r) =>
          r.id === run.id
            ? { ...r, spans: r.spans.map((sp) => (sp.end === null ? { ...sp, end, status: "error" as const, error: aborted ? "Stopped." : "Connection lost." } : sp)) }
            : r,
        ),
      }));
    } finally {
      controller = null;
      set({ streaming: null });
      // A failed request leaves an empty run behind; drop it.
      if (!get().runs.find((r) => r.id === run.id)?.spans.length) {
        set((s) => {
          const runs = s.runs.filter((r) => r.id !== run.id);
          return { runs, ...(s.activeId === run.id ? freshRunState(runs[0]) : {}) };
        });
      }
    }
  },

  stopRun: () => controller?.abort(),

  async importFile(file) {
    try {
      const imported = parseTraceFile(await file.text(), file.name);
      set((s) => ({ runs: [...imported, ...s.runs], ...freshRunState(imported[0]), view: "trace" }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Couldn't import that file." });
    }
  },

  dismissError: () => set({ error: null }),
}));

export const useActiveRun = () => useStore((s) => s.runs.find((r) => r.id === s.activeId));

