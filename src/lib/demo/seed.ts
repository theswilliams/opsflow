import { MockAIProvider } from "@/lib/ai/mock-provider";
import { addDays, todayIn, weekdayIndex } from "@/lib/dates";
import type { Db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/service";
import { createCredential } from "@/lib/webhook/credentials";
import { ActionError, SimulatedConfirmationProvider, type ActionProvider } from "@/lib/workflow/action-provider";
import { approveWorkflow, createWorkflow, editWorkflowFields, processWorkflow, rejectWorkflow, type WorkflowDeps } from "@/lib/workflow/service";

export const DEMO_EMAIL = "demo@opsflow.test";

/** Simulates an external system outage so the demo has a genuinely failed workflow. */
class OutageActionProvider implements ActionProvider {
  readonly name = "simulated-outage";
  readonly mode = "simulated" as const;
  async execute(): Promise<never> {
    throw new ActionError("Confirmation service timed out (simulated outage).");
  }
}

export const DEMO_REQUESTS = {
  straightforward: (date: string) =>
    `Customer: Northfield Lumber\n\nHi team,\nPlease deliver 6 pallets of 2x4 studs to 480 Wellington Road, London, Ontario on ${date} between 8 and 10am.\nCall Priya at 519-555-0187 when the driver arrives.\n\nThanks!`,
  ambiguousTime: `Customer: ABC Building Supplies\n\nHi,\n\nCan you deliver 4 pallets of roofing shingles to\n125 King Street, London Ontario this Friday morning?\n\nPlease call Mike when the driver is on the way.\n\nThanks`,
  missingAddress: "Customer: Harbour Roofing\n\nNeed 10 bundles of cedar shakes sent to the site tomorrow afternoon. Ask for Dev when you get there.",
  lowConfidence: "Customer: Maple Leaf Homes\n\n3 skids of drywall to 77 Oak Avenue on 03/04/2027, morning please. Contact Sam.",
  duplicate: `Customer: ABC Building Supplies\n\nHi,\n\nCan you deliver 4 pallets of roofing shingles to\n125 King Street, London Ontario this Friday morning?\n\nPlease call Mike when the driver is on the way.`,
} as const;

export interface SeedResult {
  userId: string;
  email: string;
  credential?: { keyId: string; secret: string };
  workflowIds: Record<string, string>;
}

/** Idempotent: rebuilds the demo user's workflows from scratch through the real pipeline. */
export async function seedDemo(db: Db, options: { password: string; now?: Date; timezone?: string; withCredential?: boolean }): Promise<SeedResult> {
  const now = options.now ?? new Date();
  const timezone = options.timezone ?? "America/Toronto";
  const passwordHash = await hashPassword(options.password);
  const user = await db.user.upsert({
    where: { email: DEMO_EMAIL },
    create: { email: DEMO_EMAIL, name: "Demo Dispatcher", passwordHash },
    update: { passwordHash },
  });
  await db.workflow.deleteMany({ where: { userId: user.id } });
  await db.auditEvent.deleteMany({ where: { userId: user.id } });

  const base: WorkflowDeps = {
    db,
    ai: new MockAIProvider(),
    actions: new SimulatedConfirmationProvider(),
    now: () => now,
    timezone,
    extraction: { retryDelayMs: 0 },
  };
  const actor = { type: "USER", id: user.id } as const;
  const today = todayIn(timezone, now);
  let deliveryDate = addDays(today, 2);
  while ([0, 6].includes(weekdayIndex(deliveryDate))) deliveryDate = addDays(deliveryDate, 1);

  const ids: Record<string, string> = {};
  const create = async (key: string, text: string, source: "PASTE" | "WEBHOOK" = "PASTE") => {
    const c = await createWorkflow(base, { userId: user.id, actor: source === "WEBHOOK" ? { type: "WEBHOOK", id: "demo" } : actor, source, kind: "text", text });
    ids[key] = c.id;
    await processWorkflow(base, { workflowId: c.id, userId: user.id });
    return c.id;
  };

  // 1. Completed
  const completed = await create("completed", DEMO_REQUESTS.straightforward(deliveryDate));
  await approveWorkflow(base, { workflowId: completed, userId: user.id, actor });

  // 2. Failed: approved, but the external action failed
  const failed = await create("failed", "Customer: Lakeshore Concrete\n\nDeliver 12 bags of mortar mix to 900 Lakeshore Road, London, Ontario on " + deliveryDate + " at 7am. Call Rui 519-555-0111.", "WEBHOOK");
  await approveWorkflow({ ...base, actions: new OutageActionProvider() }, { workflowId: failed, userId: user.id, actor });

  // 3. Review required: ambiguous time
  await create("review", DEMO_REQUESTS.ambiguousTime);

  // 4. Rejected duplicate
  const rejected = await create("rejected", DEMO_REQUESTS.duplicate.replace("this Friday", "Friday"));
  await rejectWorkflow(base, { workflowId: rejected, userId: user.id, actor, comment: "Duplicate of an existing order." });

  // 5. Missing information: no address
  await create("missing", DEMO_REQUESTS.missingAddress);

  // 6. AI extraction warning: low-confidence / ambiguous date
  await create("lowConfidence", DEMO_REQUESTS.lowConfidence);

  // 7. Edited then waiting for final approval
  const edited = await create("edited", `Customer: Cedar Ridge Builders\n\nSend 8 pallets of OSB sheathing to 15 Colborne Street, London, Ontario on ${deliveryDate} in the afternoon. Call Jo.`);
  await editWorkflowFields(base, { workflowId: edited, userId: user.id, actor, updates: { contact_phone: "519-555-0199", requested_time_start: "13:00", requested_time_end: "15:00" } });

  let credential: SeedResult["credential"];
  if (options.withCredential) {
    await db.apiCredential.deleteMany({ where: { userId: user.id, label: "Demo n8n" } });
    credential = await createCredential(db, user.id, "Demo n8n");
  }
  return { userId: user.id, email: DEMO_EMAIL, credential, workflowIds: ids };
}
