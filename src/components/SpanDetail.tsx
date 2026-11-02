"use client";

import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { formatMs, formatUsd, spanCost } from "@/lib/analysis";
import type { Span } from "@/lib/trace";

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="whitespace-pre-wrap text-ok/90">&quot;{value}&quot;</span>;
  if (value === null || value === undefined) return <span className="text-faint">null</span>;
  return <span className="text-llm">{String(value)}</span>;
}

function JsonNode({ label, value, depth = 0 }: { label?: string; value: unknown; depth?: number }) {
  const isBranch = typeof value === "object" && value !== null;
  const [open, setOpen] = useState(depth < 2);
  const prefix = label !== undefined && <span className="text-muted">{label}: </span>;
  if (!isBranch) {
    return (
      <div className="break-words" style={{ paddingLeft: 14 }}>
        {prefix}
        <Scalar value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center text-left hover:text-text">
        <ChevronRight className={clsx("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
        {prefix}
        <span className="text-faint">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && (
        <div className="ml-1.5 border-l border-border pl-1">
          {entries.map(([k, v]) => (
            <JsonNode key={k} label={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

interface Message {
  role: string;
  content?: string | null;
  tool_calls?: { function?: { name?: string; arguments?: string } }[];
}

const isMessages = (v: unknown): v is Message[] =>
  Array.isArray(v) && v.length > 0 && v.every((m) => typeof m === "object" && m !== null && "role" in m);

const ROLE_STYLE: Record<string, string> = {
  system: "text-faint",
  user: "text-accent",
  assistant: "text-llm",
  tool: "text-tool",
};

function Messages({ messages }: { messages: Message[] }) {
  return (
    <ol className="space-y-2">
      {messages.map((m, i) => (
        <li key={i} className="rounded-lg border border-border bg-panel-2/50 p-2.5">
          <div className={clsx("mb-1 font-mono text-[10px] font-semibold uppercase", ROLE_STYLE[m.role] ?? "text-muted")}>{m.role}</div>
          {m.content && <Prose text={m.content} />}
          {m.tool_calls?.map((c, j) => (
            <p key={j} className="font-mono text-[11px] break-words text-tool">
              {c.function?.name}({c.function?.arguments})
            </p>
          ))}
        </li>
      ))}
    </ol>
  );
}

/** Just enough markdown for agent answers: **bold** and `code`. */
function Prose({ text }: { text: string }) {
  return (
    <p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-text/90">
      {text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
        part.startsWith("**") ? (
          <strong key={i} className="font-semibold text-text">
            {part.slice(2, -2)}
          </strong>
        ) : part.startsWith("`") ? (
          <code key={i} className="rounded bg-panel-2 px-1 font-mono text-[11px]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function Payload({ value }: { value: unknown }) {
  if (typeof value === "string") return <Prose text={value} />;
  if (isMessages(value)) return <Messages messages={value} />;
  return (
    <div className="-ml-1 font-mono text-[11px] leading-relaxed">
      <JsonNode value={value} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-wider text-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function SpanDetail({ span, now }: { span: Span | undefined; now: number }) {
  if (!span) return <div className="flex h-full items-center justify-center p-6 text-xs text-faint">Select a span to inspect it.</div>;
  const running = span.status === "running";
  const facts: [string, string][] = [
    ["Duration", `${formatMs((span.end ?? now) - span.start)}${running ? " so far" : ""}`],
    ["Started", `+${formatMs(span.start)}`],
  ];
  if (span.model) facts.push(["Model", span.model]);
  if (span.usage) {
    facts.push(["Tokens in", `${span.usage.input.toLocaleString()}${span.usage.cached ? ` (${span.usage.cached.toLocaleString()} cached)` : ""}`]);
    facts.push(["Tokens out", span.usage.output.toLocaleString()]);
    const cost = spanCost(span);
    if (cost) facts.push(["Est. cost", formatUsd(cost)]);
  }
  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <header>
        <div className="flex items-center gap-2">
          <span className={clsx("rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", span.kind === "llm" ? "bg-llm/15 text-llm" : span.kind === "tool" ? "bg-tool/15 text-tool" : "bg-agent/50 text-text")}>
            {span.kind}
          </span>
          <span className={clsx("text-[11px] font-medium", span.status === "error" ? "text-bad" : running ? "text-accent" : "text-ok")}>{span.status}</span>
        </div>
        <h2 className="mt-1.5 font-mono text-sm font-semibold break-words">{span.name}</h2>
      </header>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[10px] text-faint">{k}</dt>
            <dd className="font-mono text-[11px] break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {span.error && <p className="rounded-lg border border-bad/30 bg-bad/10 p-2.5 font-mono text-[11px] break-words text-bad">{span.error}</p>}
      {span.output !== undefined && span.output !== "" && (
        <Section title="Output">
          <Payload value={span.output} />
        </Section>
      )}
      {span.input !== undefined && (
        <Section title="Input">
          <Payload value={span.input} />
        </Section>
      )}
    </div>
  );
}
