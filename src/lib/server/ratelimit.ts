import "server-only";

/**
 * Fixed-window rate limiting for the shared demo key. Uses Upstash Redis over REST
 * when UPSTASH_REDIS_REST_URL/TOKEN are set (survives serverless cold starts), and
 * falls back to per-instance memory otherwise.
 */
const PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR ?? 10);
const PER_DAY_GLOBAL = Number(process.env.RATE_LIMIT_GLOBAL_PER_DAY ?? 300);

const memory = new Map<string, { count: number; resetAt: number }>();

async function incrMemory(key: string, windowSec: number): Promise<number> {
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return 1;
  }
  return ++entry.count;
}

async function incrUpstash(key: string, windowSec: number): Promise<number> {
  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, String(windowSec), "NX"],
    ]),
    cache: "no-store",
  });
  const out = (await res.json()) as { result: number }[];
  return out[0].result;
}

const incr = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? incrUpstash : incrMemory;

export async function checkRateLimit(ip: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const hour = Math.floor(Date.now() / 3_600_000);
  const day = Math.floor(Date.now() / 86_400_000);
  try {
    const [mine, global] = await Promise.all([
      incr(`rl:ip:${ip}:${hour}`, 3600),
      incr(`rl:global:${day}`, 86400),
    ]);
    if (mine > PER_HOUR) return { ok: false, reason: "You've hit the hourly limit for live runs. The recorded runs still work." };
    if (global > PER_DAY_GLOBAL) return { ok: false, reason: "Live runs have hit their daily budget. The recorded runs still work." };
    return { ok: true };
  } catch {
    return { ok: true }; // never let the limiter take the app down
  }
}
