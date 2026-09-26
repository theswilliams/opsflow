import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db";
import { exportUserData } from "@/lib/privacy";

export const dynamic = "force-dynamic";

/** GET /api/account/export — everything OpsFlow holds about the signed-in user, as a JSON download. */
export async function GET(request: Request) {
  // Browsers label cross-site navigations; refuse them so another site cannot make a signed-in user's browser
  // trigger an export. (Requests without the header — curl, tests — are unaffected: they still need the session cookie.)
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return Response.json({ error: { code: "forbidden", message: "Cross-site requests are not allowed." } }, { status: 403 });
  }
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: { code: "unauthorized", message: "Sign in to export your data." } }, { status: 401 });
  const data = await exportUserData(getDb(), user.id);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="opsflow-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}
