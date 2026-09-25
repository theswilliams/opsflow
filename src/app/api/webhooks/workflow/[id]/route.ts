import { handleWorkflowGet } from "@/lib/webhook/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleWorkflowGet(request, id);
}
