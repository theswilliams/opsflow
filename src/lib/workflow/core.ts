import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowStatus } from "@/generated/prisma/enums";
import { getAIProvider } from "@/lib/ai";
import type { ExtractionOptions } from "@/lib/ai/extract";
import type { AIProvider } from "@/lib/ai/provider";
import type { ExtractedFields } from "@/lib/ai/schema";
import type { Budget, Prices } from "@/lib/ai/usage";
import { todayIn } from "@/lib/dates";
import { getDb, type Db } from "@/lib/db";
import type { PdfOptions } from "@/lib/documents/pdf-worker";
import { getEnv } from "@/lib/env";
import { normalizeAddress, normalizeCustomer } from "@/lib/validation/normalize";
import { validateDelivery, type ValidationOutcome } from "@/lib/validation/delivery";
import { SimulatedConfirmationProvider, type ActionProvider } from "./action-provider";
import { WorkflowError } from "./errors";
import { assertTransition, type WorkflowStatusName } from "./state-machine";

export type Client = Db | Prisma.TransactionClient;

export interface WorkflowDeps {
  db: Db;
  /**
   * Provider factory. Resolved lazily so that paths that never call an AI (review, approval) work even when
   * the provider is misconfigured, and so a misconfiguration surfaces as an explicit error at the point of use
   * — never as an `undefined` cast to a provider.
   */
  ai: () => AIProvider;
  actions: ActionProvider;
  now: () => Date;
  timezone: string;
  extraction?: ExtractionOptions;
  pdf?: PdfOptions;
  budget: Budget;
  prices: Prices;
  workerId: string;
  leaseMs: number;
  maxJobAttempts: number;
  /** Base delay before a failed job attempt is retried. */
  retryBackoffMs: number;
  /** How long a user-facing request waits for its own job before returning (the job keeps running). */
  inlineTimeoutMs: number;
  /** A workflow in a working state with no active job for this long is considered orphaned. */
  orphanGraceMs: number;
  /** Days after completion before documents/extracted data are purged. 0 disables purging. */
  retentionDays: number;
}

export function defaultDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  const env = getEnv();
  const db = getDb();
  return {
    db,
    ai: getAIProvider,
    actions: new SimulatedConfirmationProvider(db),
    now: () => new Date(),
    timezone: env.BUSINESS_TIMEZONE,
    budget: { dailyRequests: env.AI_DAILY_REQUEST_BUDGET, dailyTokens: env.AI_DAILY_TOKEN_BUDGET, monthlyCostUsd: env.AI_MONTHLY_COST_BUDGET_USD },
    prices: { inputUsdPerMTok: env.AI_PRICE_INPUT_USD_PER_MTOK, outputUsdPerMTok: env.AI_PRICE_OUTPUT_USD_PER_MTOK },
    workerId: `worker-${process.pid}-${randomUUID().slice(0, 8)}`,
    leaseMs: env.JOB_LEASE_SECONDS * 1000,
    maxJobAttempts: env.JOB_MAX_ATTEMPTS,
    retryBackoffMs: 5_000,
    inlineTimeoutMs: 25_000,
    orphanGraceMs: 2 * 60_000,
    retentionDays: env.RETENTION_DAYS,
    pdf: { timeoutMs: env.PDF_TIMEOUT_MS },
    ...overrides,
  };
}

/** Compare-and-set status change: a concurrent request that already moved the workflow loses. */
export async function transition(
  client: Client,
  args: { workflowId: string; userId: string; from: WorkflowStatusName; to: WorkflowStatusName; data?: Prisma.WorkflowUncheckedUpdateManyInput },
) {
  assertTransition(args.from, args.to);
  const { count } = await client.workflow.updateMany({
    where: { id: args.workflowId, userId: args.userId, status: args.from as WorkflowStatus },
    data: { ...args.data, status: args.to as WorkflowStatus },
  });
  if (count !== 1) throw new WorkflowError("CONFLICT", "This workflow was changed by someone else. Reload and try again.");
}

export async function loadOwned(db: Db, userId: string, workflowId: string) {
  const workflow = await db.workflow.findFirst({
    where: { id: workflowId, userId },
    include: { input: true, extracted: true },
  });
  if (!workflow) throw new WorkflowError("NOT_FOUND", "Workflow not found.");
  return workflow;
}

/** Denormalised, normalised keys stored on the workflow for indexed duplicate detection. */
export function duplicateKeys(fields: ExtractedFields) {
  return {
    customerName: fields.customer,
    customerKey: fields.customer ? normalizeCustomer(fields.customer) || null : null,
    addressKey: fields.address ? normalizeAddress(fields.address) || null : null,
    deliveryDate: fields.requested_date,
  };
}

/**
 * Indexed duplicate lookup: same normalised customer + address + delivery date among this user's
 * workflows that are still meaningful (not rejected/failed). No row cap, no fuzzy scan, deterministic order.
 */
export async function findDuplicates(client: Client, userId: string, workflowId: string, fields: ExtractedFields) {
  const keys = duplicateKeys(fields);
  if (!keys.customerKey || !keys.addressKey || !keys.deliveryDate) return [];
  return client.workflow.findMany({
    where: {
      userId,
      id: { not: workflowId },
      customerKey: keys.customerKey,
      deliveryDate: keys.deliveryDate,
      addressKey: keys.addressKey,
      status: { notIn: ["REJECTED", "FAILED"] },
    },
    select: { id: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 10,
  });
}

export async function computeValidation(deps: WorkflowDeps, userId: string, workflowId: string, fields: ExtractedFields): Promise<ValidationOutcome> {
  return validateDelivery(fields, {
    today: todayIn(deps.timezone, deps.now()),
    duplicates: await findDuplicates(deps.db, userId, workflowId, fields),
    workflowType: "DELIVERY_REQUEST",
  });
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
