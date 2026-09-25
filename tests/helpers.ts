import { randomBytes } from "node:crypto";
import { signPeer } from "@/lib/net/client-ip";
import type { AIProvider, ExtractionRequest, ProviderResponse } from "@/lib/ai/provider";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import { getDb } from "@/lib/db";
import { SimulatedConfirmationProvider, ActionError, type ActionProvider } from "@/lib/workflow/action-provider";
import type { WorkflowDeps } from "@/lib/workflow/core";
import { approveWorkflow, editWorkflowFields, submitWorkflow } from "@/lib/workflow/service";

/** Fixed clock: Monday 2026-09-28 10:00 America/Toronto (so "this Friday" = 2026-10-02). */
export const NOW = new Date("2026-09-28T14:00:00Z");
export const TODAY = "2026-09-28";

export const DELIVERY_TEXT = `Customer: ABC Building Supplies

Hi,

Can you deliver 4 pallets of roofing shingles to
125 King Street, London Ontario this Friday morning?

Please call Mike when the driver is on the way.

Thanks`;

/** A clean, fully specified request (no warnings expected except none). */
export const CLEAN_TEXT =
  "Customer: Acme Supply\n2 pallets of brick to 480 Wellington Road, London, Ontario on 2026-10-06 at 9am. Call Sam 519-555-0100.";

type DepsOverrides = Omit<Partial<WorkflowDeps>, "ai"> & { ai?: AIProvider | (() => AIProvider) };

export function testDeps(overrides: DepsOverrides = {}): WorkflowDeps {
  const db = overrides.db ?? getDb();
  const { ai, ...rest } = overrides;
  return {
    db,
    ai: typeof ai === "function" ? ai : ai ? () => ai : () => new MockAIProvider(),
    actions: new SimulatedConfirmationProvider(db),
    now: () => NOW,
    timezone: "America/Toronto",
    extraction: { retryDelayMs: 0 },
    budget: { dailyRequests: 0, dailyTokens: 0, monthlyCostUsd: 0 },
    prices: {},
    workerId: `test-${randomBytes(4).toString("hex")}`,
    leaseMs: 60_000,
    maxJobAttempts: 3,
    retryBackoffMs: 0,
    inlineTimeoutMs: 20_000,
    orphanGraceMs: 1_000,
    retentionDays: 0,
    pdf: { timeoutMs: 10_000 },
    ...rest,
  };
}

export async function makeUser(label = "u") {
  return getDb().user.create({
    data: { email: `${label}-${randomBytes(6).toString("hex")}@example.test`, name: `User ${label}`, passwordHash: "x" },
  });
}

/** Stand-in for what server.mjs stamps on a request: the real peer address plus its MAC. */
export const PEER_SECRET = "test-peer-secret";
export const peerH = (ip: string) => ({ "x-opsflow-peer": ip, "x-opsflow-peer-mac": signPeer(PEER_SECRET, ip) });

export const actorOf = (userId: string) => ({ type: "USER", id: userId }) as const;

/** Creates a workflow and processes it (inline) up to REVIEW_REQUIRED (or FAILED). */
export async function makeWorkflow(userId: string, text = DELIVERY_TEXT, deps = testDeps(), idempotencyKey?: string) {
  const created = await submitWorkflow(deps, { userId, actor: actorOf(userId), source: "PASTE", kind: "text", text, idempotencyKey });
  const workflow = await deps.db.workflow.findUniqueOrThrow({ where: { id: created.id } });
  return { id: created.id, workflow };
}

export const versionOf = async (workflowId: string) => (await getDb().workflow.findUniqueOrThrow({ where: { id: workflowId } })).version;

/** Approves whatever version is current (what a reviewer who just loaded the page would send). */
export async function approveCurrent(deps: WorkflowDeps, workflowId: string, userId: string, extra: { comment?: string; run?: boolean } = {}) {
  return approveWorkflow(deps, { workflowId, userId, actor: actorOf(userId), expectedVersion: await versionOf(workflowId), ...extra });
}

export async function editCurrent(deps: WorkflowDeps, workflowId: string, userId: string, updates: unknown) {
  return editWorkflowFields(deps, { workflowId, userId, actor: actorOf(userId), updates, expectedVersion: await versionOf(workflowId) });
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

/**
 * Behaves like a real idempotent provider (Stripe/SES style): the first call per key performs "the side
 * effect", later calls with the same key return the original result without repeating it.
 */
export class RecordingActionProvider implements ActionProvider {
  readonly name = "recording";
  readonly mode = "simulated" as const;
  /** Number of REAL side effects performed (i.e. emails "sent"). */
  sent = 0;
  readonly keysSeen: string[] = [];
  private readonly results = new Map<string, unknown>();
  constructor(private readonly inner: ActionProvider) {}
  async execute(ctx: Parameters<ActionProvider["execute"]>[0], options: { idempotencyKey: string }) {
    this.keysSeen.push(options.idempotencyKey);
    const prior = this.results.get(options.idempotencyKey);
    if (prior) return prior as Awaited<ReturnType<ActionProvider["execute"]>>;
    this.sent++;
    const result = await this.inner.execute(ctx, options);
    this.results.set(options.idempotencyKey, result);
    return result;
  }
}
