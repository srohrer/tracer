/**
 * The sandbox the demo agent investigates: a fictional outage, served by simulated
 * tools over fixed data. The model calls and its tokens are real; the tools and their
 * latencies are not. Root cause: payments-api v2.14.0 cut its database connection pool
 * from 50 to 5. The CDN change just before it is a red herring.
 */

export const DEFAULT_TASK =
  "Checkout latency spiked around 14:20 today. Find the root cause and recommend what to do right now.";

export const SYSTEM_PROMPT = `You are an on-call SRE investigating a production incident at a fictional online store. Use the tools to gather evidence before you conclude; don't guess. When several checks are independent, call the tools in parallel. If a tool fails transiently, retry it. Once you have the root cause, reply without calling a tool: name the cause, cite the evidence, and give the immediate action, in under 120 words. Only answer questions about this incident environment.`;

const SERVICES = ["checkout-web", "payments-api", "postgres-payments", "redis-sessions", "cdn"];
const TIMES = ["14:00", "14:05", "14:10", "14:15", "14:20", "14:25", "14:30", "14:35", "14:40"];

const METRICS: Record<string, Record<string, number[]>> = {
  "checkout-web": {
    latency_p95_ms: [310, 305, 320, 690, 2840, 4120, 4380, 4210, 4300],
    error_rate_pct: [0.1, 0.1, 0.1, 0.4, 3.2, 6.8, 7.4, 7.1, 7.2],
    cpu_pct: [41, 40, 42, 44, 46, 45, 44, 45, 44],
  },
  "payments-api": {
    latency_p95_ms: [120, 118, 125, 540, 2410, 3780, 3990, 3850, 3920],
    error_rate_pct: [0, 0, 0, 0.9, 5.1, 11.2, 12.4, 11.9, 12.1],
    db_connections_in_use: [34, 33, 36, 5, 5, 5, 5, 5, 5],
    cpu_pct: [38, 37, 39, 30, 24, 21, 20, 21, 20],
  },
  "postgres-payments": {
    latency_p95_ms: [8, 8, 9, 8, 7, 7, 7, 8, 7],
    db_connections_in_use: [36, 35, 38, 7, 7, 7, 7, 7, 7],
    cpu_pct: [29, 28, 30, 12, 10, 9, 9, 10, 9],
  },
  "redis-sessions": {
    latency_p95_ms: [2, 2, 2, 2, 2, 2, 2, 2, 2],
    cache_hit_pct: [98, 98, 98, 98, 98, 98, 98, 98, 98],
  },
  cdn: {
    latency_p95_ms: [45, 52, 47, 46, 48, 47, 46, 47, 46],
    cache_hit_pct: [94, 90, 93, 94, 94, 94, 94, 94, 94],
  },
};

const DEPLOYS = [
  { at: "13:32", service: "checkout-web", version: "v5.8.1", author: "dana", summary: "Copy tweak on the order review page" },
  { at: "14:04", service: "cdn", version: "config-881", author: "marek", summary: "Lower image cache TTL from 24h to 12h" },
  { at: "14:12", service: "payments-api", version: "v2.14.0", author: "jun", summary: "Refactor DB config; pool size now read from POOL_MAX (default 5, was hardcoded 50)" },
];

const LOGS = [
  { at: "14:04", service: "cdn", level: "info", msg: "config-881 applied to all edges" },
  { at: "14:12", service: "payments-api", level: "info", msg: "started v2.14.0, db pool max=5" },
  { at: "14:14", service: "payments-api", level: "warn", msg: "db pool saturated: 5/5 in use, 41 waiting" },
  { at: "14:16", service: "payments-api", level: "error", msg: "timeout acquiring db connection after 2000ms" },
  { at: "14:18", service: "checkout-web", level: "warn", msg: "POST /payments/authorize slow: 2310ms" },
  { at: "14:21", service: "payments-api", level: "error", msg: "timeout acquiring db connection after 2000ms (312 in last minute)" },
  { at: "14:22", service: "checkout-web", level: "error", msg: "POST /payments/authorize returned 503" },
  { at: "14:24", service: "postgres-payments", level: "info", msg: "connections: 7 active, no slow queries, no locks" },
  { at: "14:26", service: "redis-sessions", level: "info", msg: "healthy, memory 41%" },
];

const RUNBOOKS: Record<string, string> = {
  "db-connection-exhaustion":
    "Symptoms: app latency up while database CPU and query times are flat or down; 'timeout acquiring connection' errors. Mitigation: roll back the service or raise its pool size. Postgres max_connections here is 200, so 50 per service is safe.",
  rollback: "Run `deploy rollback <service>`. Takes about 2 minutes. No migration concerns unless the deploy notes mention one.",
  "cdn-issues": "Symptoms: cache hit below 80%, origin load up, asset latency up. Mitigation: restore the previous config.",
};

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_services",
      description: "List the services in this environment.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_metrics",
      description: "Time series for a service from 14:00 to 14:40 at 5 minute intervals.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string" },
          metric: { type: "string", enum: ["latency_p95_ms", "error_rate_pct", "db_connections_in_use", "cpu_pct", "cache_hit_pct"] },
        },
        required: ["service", "metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_deploys",
      description: "Deploys and config changes today, optionally for one service.",
      parameters: { type: "object", properties: { service: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "search_logs",
      description: "Search log lines, optionally by service and/or a text query.",
      parameters: { type: "object", properties: { service: { type: "string" }, query: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "read_runbook",
      description: "Read a runbook. Topics: db-connection-exhaustion, rollback, cdn-issues.",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    },
  },
];

/** Simulated latency per tool, so the timeline resembles real infrastructure. */
const LATENCY_MS: Record<string, number> = {
  list_services: 90,
  get_metrics: 420,
  get_deploys: 180,
  search_logs: 760,
  read_runbook: 140,
};

export const toolLatency = (name: string) => LATENCY_MS[name] ?? 100;

export class ToolError extends Error {}

export interface ToolContext {
  /** fail the first get_metrics call, to put a realistic error and retry in the trace */
  flaky: boolean;
  metricsCalls: number;
}

export function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): unknown {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  switch (name) {
    case "list_services":
      return SERVICES;
    case "get_metrics": {
      if (ctx.flaky && ctx.metricsCalls++ === 0) throw new ToolError("metrics backend timed out after 5000ms; retry");
      const service = str("service") ?? "";
      const metric = str("metric") ?? "";
      const series = METRICS[service]?.[metric];
      if (!METRICS[service]) throw new ToolError(`unknown service "${service}". Known: ${SERVICES.join(", ")}`);
      if (!series) throw new ToolError(`${service} has no metric "${metric}". It has: ${Object.keys(METRICS[service]).join(", ")}`);
      return { service, metric, points: TIMES.map((t, i) => ({ t, value: series[i] })) };
    }
    case "get_deploys": {
      const service = str("service");
      return DEPLOYS.filter((d) => !service || d.service === service);
    }
    case "search_logs": {
      const service = str("service");
      const query = str("query")?.toLowerCase();
      return LOGS.filter((l) => (!service || l.service === service) && (!query || l.msg.toLowerCase().includes(query)));
    }
    case "read_runbook": {
      const topic = str("topic") ?? "";
      if (!RUNBOOKS[topic]) throw new ToolError(`no runbook "${topic}". Topics: ${Object.keys(RUNBOOKS).join(", ")}`);
      return RUNBOOKS[topic];
    }
    default:
      throw new ToolError(`unknown tool "${name}"`);
  }
}
