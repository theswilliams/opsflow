import { handleWorkflowPost } from "@/lib/webhook/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Processing (AI extraction) can take several seconds.
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleWorkflowPost(request);
}
