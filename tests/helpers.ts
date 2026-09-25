import { randomBytes } from "node:crypto";
import type { AIProvider, ExtractionRequest, ProviderResponse } from "@/lib/ai/provider";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import { getDb } from "@/lib/db";
import { SimulatedConfirmationProvider, ActionError, type ActionProvider } from "@/lib/workflow/action-provider";
import { createWorkflow, processWorkflow, type WorkflowDeps } from "@/lib/workflow/service";

/** Fixed clock: Monday 2026-09-28 10:00 America/Toronto (so "this Friday" = 2026-10-02). */
export const NOW = new Date("2026-09-28T14:00:00Z");
export const TODAY = "2026-09-28";

export const DELIVERY_TEXT = `Customer: ABC Building Supplies

Hi,

Can you deliver 4 pallets of roofing shingles to
125 King Street, London Ontario this Friday morning?

Please call Mike when the driver is on the way.

Thanks`;

export function testDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    db: getDb(),
    ai: new MockAIProvider(),
    actions: new SimulatedConfirmationProvider(),
    now: () => NOW,
    timezone: "America/Toronto",
    extraction: { retryDelayMs: 0 },
    ...overrides,
  };
}

export async function makeUser(label = "u") {
  return getDb().user.create({
    data: { email: `${label}-${randomBytes(6).toString("hex")}@example.test`, name: `User ${label}`, passwordHash: "x" },
  });
}

/** Creates and processes a workflow up to REVIEW_REQUIRED (or FAILED). */
export async function makeWorkflow(userId: string, text = DELIVERY_TEXT, deps = testDeps(), idempotencyKey?: string) {
  const created = await createWorkflow(deps, { userId, actor: { type: "USER", id: userId }, source: "PASTE", kind: "text", text, idempotencyKey });
  const workflow = await processWorkflow(deps, { workflowId: created.id, userId });
  return { id: created.id, workflow };
}

export class ScriptedProvider implements AIProvider {
  readonly name = "mock" as const;
  readonly isMock = true;
  calls: ExtractionRequest[] = [];
  constructor(private readonly responses: (() => Promise<ProviderResponse> | ProviderResponse)[]) {}
  async extract(request: ExtractionRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const next = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
    if (!next) throw new Error("no scripted response");
    return next();
  }
}

export class FailingActionProvider implements ActionProvider {
  readonly name = "failing";
  readonly mode = "simulated" as const;
  async execute(): Promise<never> {
    throw new ActionError("The confirmation service is unavailable.");
  }
}
