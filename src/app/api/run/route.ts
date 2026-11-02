import { z } from "zod";
import { runAgent } from "@/lib/agent/loop";
import { checkRateLimit } from "@/lib/server/ratelimit";

export const maxDuration = 60;

const Body = z.object({ task: z.string().trim().min(1).max(500) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "Describe the task in 1-500 characters." }, { status: 400 });

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return Response.json({ message: "Live runs aren't configured here. The recorded runs still work." }, { status: 503 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  const limit = await checkRateLimit(ip);
  if (!limit.ok) return Response.json({ message: limit.reason }, { status: 429 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        for await (const e of runAgent({ task: parsed.data.task, apiKey, flaky: true, signal: req.signal })) send(e);
      } catch (err) {
        send({ t: "error", message: err instanceof Error ? err.message : "The run failed." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
