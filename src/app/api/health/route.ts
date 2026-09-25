import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness + database reachability. Reveals nothing about configuration. */
export async function GET() {
  try {
    await getDb().$queryRaw`SELECT 1`;
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "degraded" }, { status: 503 });
  }
}
