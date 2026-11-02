import { connection } from "next/server";

export async function GET() {
  await connection(); // read env at request time, not build time
  return Response.json({ live: Boolean(process.env.DEEPSEEK_API_KEY) });
}
