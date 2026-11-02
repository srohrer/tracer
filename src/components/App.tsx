"use client";

import clsx from "clsx";
import { Activity, PanelLeft, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { CompareView } from "./CompareView";
import { Sidebar } from "./Sidebar";
import { TraceView } from "./TraceView";

export function App() {
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    init();
  }, [init]);

  const tab = (v: typeof view, label: string) => (
    <button
      onClick={() => setView(v)}
      aria-pressed={view === v}
      className={clsx("rounded-md px-2.5 py-1 text-xs font-medium", view === v ? "bg-panel-2 text-text" : "text-muted hover:text-text")}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-3 sm:px-4">
        <button className="text-muted hover:text-text lg:hidden" onClick={() => setDrawer((d) => !d)} aria-label="Toggle runs">
          <PanelLeft className="size-4" />
        </button>
        <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex size-6 items-center justify-center rounded-md bg-accent text-bg">
            <Activity className="size-3.5" />
          </span>
          Tracer
        </span>
        <nav className="flex gap-1 sm:ml-3">
          {tab("trace", "Trace")}
          {tab("compare", "Compare")}
        </nav>
        <div className="ml-auto flex items-center gap-4 text-xs text-muted">
          <a href="https://github.com/srohrer/tracer" target="_blank" rel="noreferrer" className="hidden hover:text-text sm:inline">
            Source
          </a>
          <a href="https://srohrer.dev" className="hover:text-text">
            srohrer.dev
          </a>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div
          className={clsx(
            "absolute inset-y-0 left-0 z-30 w-72 shrink-0 border-r border-border bg-panel lg:static lg:block",
            drawer ? "block shadow-2xl" : "hidden",
          )}
        >
          <Sidebar onPick={() => setDrawer(false)} />
        </div>
        {drawer && <div className="absolute inset-0 z-20 bg-black/40 lg:hidden" onClick={() => setDrawer(false)} />}
        <main className="min-w-0 flex-1">{view === "trace" ? <TraceView /> : <CompareView />}</main>
      </div>

      {error && (
        <div role="alert" className="fixed bottom-4 left-1/2 z-50 flex w-[min(520px,calc(100vw-32px))] -translate-x-1/2 items-start gap-3 rounded-xl border border-bad/40 bg-panel px-4 py-3 text-sm shadow-2xl">
          <span className="flex-1">{error}</span>
          <button onClick={dismissError} aria-label="Dismiss" className="text-muted hover:text-text">
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
