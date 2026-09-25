import { Prisma } from "@/generated/prisma/client";
import type { WorkflowSource, WorkflowStatus } from "@/generated/prisma/enums";
import { getAIProvider } from "@/lib/ai";
import { cleanText, extractWorkflowData, ExtractionError, type ExtractionOptions } from "@/lib/ai/extract";
import type { AIProvider } from "@/lib/ai/provider";
import { editableFieldsSchema, type Extraction, type ExtractedFields, type FieldAssessment, type FieldAssessments } from "@/lib/ai/schema";
import { sha256 } from "@/lib/crypto";
import { todayIn } from "@/lib/dates";
import { getDb, type Db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { normalizeAddress, validateDelivery, type ValidationOutcome } from "@/lib/validation/delivery";
import { decideReview } from "@/lib/validation/rules";
import { ActionError, SimulatedConfirmationProvider, type ActionProvider } from "./action-provider";
import { AUDIT, auditValue, recordAudit, type Actor } from "./audit";
import { WorkflowError } from "./errors";
import { assertTransition, type WorkflowStatusName } from "./state-machine";

export interface WorkflowDeps {
  db: Db;
  ai: AIProvider;
  actions: ActionProvider;
  now: () => Date;
  timezone: string;
  extraction?: ExtractionOptions;
}

export function defaultDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    db: getDb(),
    ai: getAIProvider(),
    actions: new SimulatedConfirmationProvider(),
    now: () => new Date(),
    timezone: getEnv().BUSINESS_TIMEZONE,
    ...overrides,
  };
}

/** Deps for read/edit/approve paths that never call the AI provider. */
export function lightDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    db: getDb(),
    ai: undefined as unknown as AIProvider,
    actions: new SimulatedConfirmationProvider(),
    now: () => new Date(),
    timezone: getEnv().BUSINESS_TIMEZONE,
    ...overrides,
  };
}

const json = (v: unknown) => v as Prisma.InputJsonValue;
type StoredAssessment = FieldAssessment & { edited?: boolean };
export type StoredAssessments = { [K in keyof FieldAssessments]: StoredAssessment };

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/** Compare-and-set status change: a concurrent request that already moved the workflow loses. */
async function transition(
  client: Db | Prisma.TransactionClient,
  args: { workflowId: string; userId: string; from: WorkflowStatusName; to: WorkflowStatusName; data?: Prisma.WorkflowUncheckedUpdateManyInput },
) {
  assertTransition(args.from, args.to);
  const { count } = await client.workflow.updateMany({
    where: { id: args.workflowId, userId: args.userId, status: args.from as WorkflowStatus },
    data: { ...args.data, status: args.to as WorkflowStatus },
  });
  if (count !== 1) throw new WorkflowError("CONFLICT", "This workflow was changed by someone else. Reload and try again.");
}

async function loadOwned(db: Db, userId: string, workflowId: string) {
  const workflow = await db.workflow.findFirst({
    where: { id: workflowId, userId },
    include: { input: true, extracted: true },
  });
  if (!workflow) throw new WorkflowError("NOT_FOUND", "Workflow not found.");
  return workflow;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateWorkflowInput {
  userId: string;
  actor: Actor;
  source: WorkflowSource;
  kind: "text" | "document";
  text: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  idempotencyKey?: string;
}

export interface CreateWorkflowResult {
  id: string;
  duplicate: boolean;
  /** True when an idempotency key was reused with different content. */
  conflict: boolean;
}

export async function createWorkflow(deps: WorkflowDeps, input: CreateWorkflowInput): Promise<CreateWorkflowResult> {
  const text = cleanText(input.text).trim();
  if (!text) throw new WorkflowError("BAD_INPUT", "The request contained no text.");
  const contentHash = sha256(text);

  const findExisting = () =>
    input.idempotencyKey
      ? deps.db.workflow.findFirst({
          where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
          include: { input: { select: { contentHash: true } } },
        })
      : null;

  const existing = await findExisting();
  if (existing) return { id: existing.id, duplicate: true, conflict: existing.input?.contentHash !== contentHash };

  try {
    const workflow = await deps.db.$transaction(async (tx) => {
      const w = await tx.workflow.create({
        data: { userId: input.userId, type: "DELIVERY_REQUEST", source: input.source, idempotencyKey: input.idempotencyKey ?? null },
      });
      await tx.workflowInput.create({
        data: {
          workflowId: w.id,
          userId: input.userId,
          kind: input.kind,
          fileName: input.fileName ?? null,
          mimeType: input.mimeType ?? null,
          sizeBytes: input.sizeBytes ?? Buffer.byteLength(text),
          contentHash,
          content: text,
        },
      });
      await recordAudit(tx, {
        userId: input.userId,
        workflowId: w.id,
        actor: input.actor,
        eventType: AUDIT.RECEIVED,
        message: `Request received via ${input.source.toLowerCase()}`,
        metadata: { source: input.source, kind: input.kind, sizeBytes: Buffer.byteLength(text) },
      });
      return w;
    });
    return { id: workflow.id, duplicate: false, conflict: false };
  } catch (err) {
    // Lost a race on the (userId, idempotencyKey) unique constraint.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await findExisting();
      if (raced) return { id: raced.id, duplicate: true, conflict: raced.input?.contentHash !== contentHash };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Process: extraction → validation → review
// ---------------------------------------------------------------------------

async function findDuplicates(deps: WorkflowDeps, userId: string, workflowId: string, fields: ExtractedFields) {
  if (!fields.customer || !fields.address || !fields.requested_date) return [];
  const candidates = await deps.db.workflow.findMany({
    where: {
      userId,
      id: { not: workflowId },
      status: { notIn: ["REJECTED", "FAILED"] },
      customerName: { equals: fields.customer, mode: "insensitive" },
    },
    include: { extracted: { select: { fields: true } } },
    take: 25,
  });
  const address = normalizeAddress(fields.address);
  return candidates
    .filter((c) => {
      const f = c.extracted?.fields as ExtractedFields | undefined;
      return f?.address && normalizeAddress(f.address) === address && f.requested_date === fields.requested_date;
    })
    .map((c) => ({ id: c.id }));
}

/** Runs validation + business rules and persists the result. Expects status VALIDATING. */
async function validateAndRoute(deps: WorkflowDeps, userId: string, workflowId: string) {
  const extracted = await deps.db.extractedData.findFirstOrThrow({ where: { workflowId, userId } });
  const fields = extracted.fields as unknown as ExtractedFields;
  const assessments = extracted.fieldStatus as unknown as FieldAssessments;
  const ambiguities = extracted.ambiguities as unknown as Extraction["ambiguities"];

  const validation = validateDelivery(fields, {
    today: todayIn(deps.timezone, deps.now()),
    duplicates: await findDuplicates(deps, userId, workflowId, fields),
    workflowType: "DELIVERY_REQUEST",
  });
  const decision = decideReview({ requiresHumanReview: extracted.requiresHumanReview, aiReason: extracted.reason, assessments, ambiguities, validation });

  await deps.db.$transaction(async (tx) => {
    await tx.validationResult.create({
      data: { workflowId, userId, passed: validation.passed, errorCount: validation.errorCount, warningCount: validation.warningCount, issues: json(validation.issues) },
    });
    await recordAudit(tx, {
      userId,
      workflowId,
      actor: { type: "SYSTEM" },
      eventType: AUDIT.VALIDATION_COMPLETED,
      message: validation.passed
        ? `Validation completed (${validation.warningCount} warning${validation.warningCount === 1 ? "" : "s"})`
        : `Validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}`,
      metadata: { errors: validation.errorCount, warnings: validation.warningCount, codes: validation.issues.map((i) => i.code) },
    });
    await transition(tx, {
      workflowId,
      userId,
      from: "VALIDATING",
      to: "REVIEW_REQUIRED",
      data: { customerName: fields.customer, overallConfidence: decision.overallConfidence, needsAttention: decision.needsAttention, failureReason: null },
    });
    await recordAudit(tx, {
      userId,
      workflowId,
      actor: { type: "SYSTEM" },
      eventType: AUDIT.REVIEW_REQUIRED,
      message: decision.needsAttention ? "Human review required" : "Ready for human approval",
      metadata: { needsAttention: decision.needsAttention, reasons: decision.reasons.slice(0, 6) },
    });
  });
  return { validation, decision };
}

export async function processWorkflow(deps: WorkflowDeps, args: { workflowId: string; userId: string; actor?: Actor }) {
  const { workflowId, userId } = args;
  const started = Date.now();
  const workflow = await loadOwned(deps.db, userId, workflowId);
  if (!workflow.input) throw new WorkflowError("BAD_INPUT", "Workflow has no input to process.");
  if (workflow.status !== "RECEIVED" && workflow.status !== "FAILED") {
    throw new WorkflowError("INVALID_STATE", "This workflow has already been processed.");
  }
  await transition(deps.db, { workflowId, userId, from: workflow.status, to: "PROCESSING", data: { failureReason: null } });

  const fail = async (from: WorkflowStatusName, reason: string, eventType: string, metadata: Record<string, unknown>) => {
    await deps.db.$transaction(async (tx) => {
      await transition(tx, { workflowId, userId, from, to: "FAILED", data: { failureReason: reason, needsAttention: true } });
      await recordAudit(tx, { userId, workflowId, actor: { type: "SYSTEM" }, eventType, message: reason, metadata });
    });
  };

  try {
    const outcome = await extractWorkflowData(
      deps.ai,
      { text: workflow.input.content, referenceDate: todayIn(deps.timezone, deps.now()) },
      deps.extraction,
    );
    const e = outcome.extraction;
    const stored: StoredAssessments = e.field_assessments;
    const data = {
      provider: outcome.provider,
      model: outcome.model,
      attempts: outcome.attempts,
      aiOutput: json(e),
      fields: json(e.fields),
      fieldStatus: json(stored),
      missingInformation: json(e.missing_information),
      ambiguities: json(e.ambiguities),
      requiresHumanReview: e.requires_human_review,
      reason: e.reason,
      recommendedAction: e.recommended_action,
    };
    await deps.db.$transaction(async (tx) => {
      await tx.extractedData.upsert({ where: { workflowId }, create: { workflowId, userId, ...data }, update: data });
      await transition(tx, { workflowId, userId, from: "PROCESSING", to: "EXTRACTED" });
      await recordAudit(tx, {
        userId,
        workflowId,
        actor: { type: "SYSTEM" },
        eventType: AUDIT.EXTRACTION_COMPLETED,
        message: "AI extraction completed",
        metadata: {
          provider: outcome.provider,
          model: outcome.model,
          attempts: outcome.attempts,
          durationMs: outcome.durationMs,
          missing: e.missing_information.length,
          ambiguities: e.ambiguities.length,
          corrections: outcome.corrections,
        },
      });
      await transition(tx, { workflowId, userId, from: "EXTRACTED", to: "VALIDATING" });
    });
    await validateAndRoute(deps, userId, workflowId);
    logger.info("workflow.processed", { workflowId, durationMs: Date.now() - started, provider: outcome.provider, result: "review_required" });
  } catch (err) {
    if (err instanceof ExtractionError) {
      await fail("PROCESSING", err.userMessage, AUDIT.EXTRACTION_FAILED, { code: err.code });
      logger.warn("workflow.extraction_failed", { workflowId, code: err.code, durationMs: Date.now() - started });
    } else if (err instanceof WorkflowError) {
      throw err;
    } else {
      logger.error("workflow.process_failed", { workflowId, error: err });
      const current = await deps.db.workflow.findFirst({ where: { id: workflowId, userId }, select: { status: true } });
      if (current && ["PROCESSING", "EXTRACTED", "VALIDATING"].includes(current.status)) {
        await fail(current.status as WorkflowStatusName, "Processing failed unexpectedly. Please retry.", AUDIT.FAILED, { code: "INTERNAL" }).catch(() => undefined);
      }
    }
  }
  return deps.db.workflow.findFirstOrThrow({ where: { id: workflowId, userId } });
}

// ---------------------------------------------------------------------------
// Human review: edit / approve / reject
// ---------------------------------------------------------------------------

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** Key-order-insensitive: PostgreSQL jsonb does not preserve key order. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]))
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function diffFields(before: ExtractedFields, after: ExtractedFields): FieldChange[] {
  return (Object.keys(after) as (keyof ExtractedFields)[])
    .filter((k) => !same(before[k], after[k]))
    .map((k) => ({ field: k, from: before[k], to: after[k] }));
}

export async function editWorkflowFields(deps: WorkflowDeps, args: { workflowId: string; userId: string; actor: Actor; updates: unknown }) {
  const { workflowId, userId, actor } = args;
  const parsed = editableFieldsSchema.safeParse(args.updates);
  if (!parsed.success) throw new WorkflowError("BAD_INPUT", "Some of the edited values are not valid.");
  const updates = parsed.data;

  const workflow = await loadOwned(deps.db, userId, workflowId);
  if (workflow.status !== "REVIEW_REQUIRED") throw new WorkflowError("INVALID_STATE", "Only workflows awaiting review can be edited.");
  if (!workflow.extracted) throw new WorkflowError("INVALID_STATE", "Nothing to edit yet.");

  const current = workflow.extracted.fields as unknown as ExtractedFields;
  const next: ExtractedFields = { ...current, ...updates };
  // An explicit start time supersedes a general window such as "morning".
  if (next.requested_time_start && next.requested_time_window !== "specific") next.requested_time_window = "specific";
  const changes = diffFields(current, next);
  if (changes.length === 0) throw new WorkflowError("NO_CHANGES", "No changes to save.");

  const assessments = structuredClone(workflow.extracted.fieldStatus) as unknown as StoredAssessments;
  const changedFields = new Set(changes.map((c) => c.field));
  for (const { field } of changes) {
    const key = field as keyof StoredAssessments;
    assessments[key] = { status: "known", confidence: "high", evidence: null, note: "Set by a human reviewer.", edited: true };
  }
  // Supplying a phone number resolves the "named contact but no way to reach them" concern.
  if (changedFields.has("contact_phone") && next.contact_phone && next.contact_name && !changedFields.has("contact_name")) {
    assessments.contact_name = { ...assessments.contact_name, confidence: "high", note: null };
  }
  const ambiguities = (workflow.extracted.ambiguities as unknown as Extraction["ambiguities"]).filter((a) => !changedFields.has(a.field));

  await deps.db.$transaction(async (tx) => {
    await transition(tx, { workflowId, userId, from: "REVIEW_REQUIRED", to: "VALIDATING" });
    await tx.extractedData.update({
      where: { workflowId },
      data: { fields: json(next), fieldStatus: json(assessments), ambiguities: json(ambiguities) },
    });
    await recordAudit(tx, {
      userId,
      workflowId,
      actor,
      eventType: AUDIT.FIELDS_EDITED,
      message: `Edited ${changes.map((c) => c.field.replaceAll("_", " ")).join(", ")}`,
      metadata: { changes: changes.map((c) => ({ field: c.field, from: auditValue(c.field, c.from), to: auditValue(c.field, c.to) })) },
    });
  });
  const routed = await validateAndRoute(deps, userId, workflowId);
  return { changes, validation: routed.validation };
}

export async function rejectWorkflow(deps: WorkflowDeps, args: { workflowId: string; userId: string; actor: Actor; comment?: string }) {
  const { workflowId, userId, actor } = args;
  const workflow = await loadOwned(deps.db, userId, workflowId);
  if (workflow.status !== "REVIEW_REQUIRED") throw new WorkflowError("INVALID_STATE", "Only workflows awaiting review can be rejected.");
  const comment = args.comment?.trim().slice(0, 1000) || null;
  await deps.db.$transaction(async (tx) => {
    await transition(tx, { workflowId, userId, from: "REVIEW_REQUIRED", to: "REJECTED", data: { needsAttention: false } });
    await tx.review.create({
      data: { workflowId, userId, reviewerId: "id" in actor ? actor.id : userId, decision: "REJECTED", comment, changes: json([]) },
    });
    await recordAudit(tx, { userId, workflowId, actor, eventType: AUDIT.REJECTED, message: "Request rejected", metadata: { hasComment: Boolean(comment) } });
  });
}

/** Errors that block approval are re-derived from scratch, never trusted from a stored result. */
export async function currentValidation(deps: WorkflowDeps, userId: string, workflowId: string): Promise<ValidationOutcome> {
  const extracted = await deps.db.extractedData.findFirstOrThrow({ where: { workflowId, userId } });
  const fields = extracted.fields as unknown as ExtractedFields;
  return validateDelivery(fields, {
    today: todayIn(deps.timezone, deps.now()),
    duplicates: await findDuplicates(deps, userId, workflowId, fields),
    workflowType: "DELIVERY_REQUEST",
  });
}

export async function approveWorkflow(deps: WorkflowDeps, args: { workflowId: string; userId: string; actor: Actor; comment?: string }) {
  const { workflowId, userId, actor } = args;
  const workflow = await loadOwned(deps.db, userId, workflowId);
  if (workflow.status !== "REVIEW_REQUIRED") throw new WorkflowError("INVALID_STATE", "Only workflows awaiting review can be approved.");
  if (!workflow.extracted) throw new WorkflowError("INVALID_STATE", "Nothing to approve yet.");

  const validation = await currentValidation(deps, userId, workflowId);
  if (!validation.passed) {
    throw new WorkflowError("VALIDATION_FAILED", `Fix ${validation.errorCount} validation error${validation.errorCount === 1 ? "" : "s"} before approving.`);
  }

  const original = (workflow.extracted.aiOutput as unknown as Extraction).fields;
  const current = workflow.extracted.fields as unknown as ExtractedFields;
  const changes = diffFields(original, current);
  const comment = args.comment?.trim().slice(0, 1000) || null;

  try {
    await deps.db.$transaction(async (tx) => {
      await transition(tx, { workflowId, userId, from: "REVIEW_REQUIRED", to: "APPROVED", data: { needsAttention: false } });
      await tx.review.create({
        data: {
          workflowId,
          userId,
          reviewerId: "id" in actor ? actor.id : userId,
          decision: "APPROVED",
          comment,
          changes: json(changes.map((c) => ({ field: c.field, from: auditValue(c.field, c.from), to: auditValue(c.field, c.to) }))),
        },
      });
      await recordAudit(tx, {
        userId,
        workflowId,
        actor,
        eventType: AUDIT.APPROVED,
        message: changes.length ? `Request approved with ${changes.length} edited field${changes.length === 1 ? "" : "s"}` : "Request approved",
        metadata: { editedFields: changes.map((c) => c.field) },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new WorkflowError("CONFLICT", "This workflow was already reviewed.");
    }
    throw err;
  }
  return executeApprovedWorkflow(deps, { workflowId, userId, actor });
}

// ---------------------------------------------------------------------------
// Execute (only ever after a recorded human approval)
// ---------------------------------------------------------------------------

export async function executeApprovedWorkflow(deps: WorkflowDeps, args: { workflowId: string; userId: string; actor: Actor }) {
  const { workflowId, userId, actor } = args;
  const workflow = await loadOwned(deps.db, userId, workflowId);

  // Hard boundary: a persisted human approval must exist, independent of status.
  const approval = await deps.db.review.findFirst({ where: { workflowId, userId, decision: "APPROVED" } });
  if (!approval || !workflow.extracted) {
    throw new WorkflowError("APPROVAL_REQUIRED", "This workflow has not been approved by a person, so it cannot be executed.");
  }
  if (workflow.status !== "APPROVED" && workflow.status !== "FAILED") {
    throw new WorkflowError("INVALID_STATE", "This workflow is not ready to execute.");
  }
  await transition(deps.db, { workflowId, userId, from: workflow.status, to: "EXECUTING", data: { failureReason: null } });

  const fields = workflow.extracted.fields as unknown as ExtractedFields;
  const started = Date.now();
  try {
    const result = await deps.actions.execute({ workflowId, fields });
    await deps.db.$transaction(async (tx) => {
      await tx.workflowAction.create({
        data: { workflowId, userId, type: "CUSTOMER_CONFIRMATION", status: "SUCCEEDED", mode: deps.actions.mode, executedBy: "id" in actor ? actor.id : userId, output: json(result) },
      });
      await recordAudit(tx, {
        userId,
        workflowId,
        actor: { type: "SYSTEM" },
        eventType: AUDIT.ACTION_EXECUTED,
        message: deps.actions.mode === "simulated" ? "Customer confirmation generated (simulated)" : "Customer confirmation sent",
        metadata: { provider: deps.actions.name, mode: deps.actions.mode, durationMs: Date.now() - started },
      });
      await transition(tx, { workflowId, userId, from: "EXECUTING", to: "COMPLETED", data: { needsAttention: false } });
      await recordAudit(tx, { userId, workflowId, actor: { type: "SYSTEM" }, eventType: AUDIT.COMPLETED, message: "Workflow completed" });
    });
  } catch (err) {
    const userMessage = err instanceof ActionError ? err.userMessage : "The automated action failed unexpectedly.";
    if (!(err instanceof ActionError)) logger.error("workflow.action_failed", { workflowId, error: err });
    await deps.db.$transaction(async (tx) => {
      await tx.workflowAction.create({
        data: { workflowId, userId, type: "CUSTOMER_CONFIRMATION", status: "FAILED", mode: deps.actions.mode, executedBy: "id" in actor ? actor.id : userId, error: userMessage },
      });
      await transition(tx, { workflowId, userId, from: "EXECUTING", to: "FAILED", data: { failureReason: userMessage, needsAttention: true } });
      await recordAudit(tx, {
        userId,
        workflowId,
        actor: { type: "SYSTEM" },
        eventType: AUDIT.ACTION_FAILED,
        message: `Automated action failed: ${userMessage}`,
        metadata: { provider: deps.actions.name },
      });
    });
  }
  return deps.db.workflow.findFirstOrThrow({ where: { id: workflowId, userId } });
}

/** Retry a FAILED workflow: re-run the action if it was approved, otherwise re-run processing. */
export async function retryWorkflow(deps: WorkflowDeps, args: { workflowId: string; userId: string; actor: Actor }) {
  const { workflowId, userId, actor } = args;
  const workflow = await loadOwned(deps.db, userId, workflowId);
  if (workflow.status !== "FAILED") throw new WorkflowError("INVALID_STATE", "Only failed workflows can be retried.");
  await recordAudit(deps.db, { userId, workflowId, actor, eventType: AUDIT.RETRY_REQUESTED, message: "Retry requested" });
  const approved = await deps.db.review.findFirst({ where: { workflowId, userId, decision: "APPROVED" }, select: { id: true } });
  return approved ? executeApprovedWorkflow(deps, { workflowId, userId, actor }) : processWorkflow(deps, { workflowId, userId, actor });
}
