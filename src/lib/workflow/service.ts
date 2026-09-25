import { Prisma } from "@/generated/prisma/client";
import type { WorkflowSource } from "@/generated/prisma/enums";
import { cleanText } from "@/lib/ai/extract";
import type { VerifiedAssessment } from "@/lib/ai/extract";
import { editableFieldsSchema, type Extraction, type ExtractedFields, type FieldName } from "@/lib/ai/schema";
import { sha256 } from "@/lib/crypto";
import { enqueueJob } from "@/lib/jobs/queue";
import { runJobInline } from "@/lib/jobs/worker";
import { decideReview } from "@/lib/validation/rules";
import type { ValidationOutcome } from "@/lib/validation/delivery";
import { AUDIT, auditValue, recordAudit, type Actor } from "./audit";
import { computeValidation, duplicateKeys, loadOwned, transition, type WorkflowDeps } from "./core";
import { WorkflowError } from "./errors";
import { assertPath } from "./state-machine";

export { defaultDeps, type WorkflowDeps } from "./core";

const json = (v: unknown) => v as Prisma.InputJsonValue;
export type StoredAssessments = Record<FieldName, VerifiedAssessment>;

/** Content-dedupe window for webhook requests: the same request text from the same tenant inside it is one request. */
export const WEBHOOK_CONTENT_WINDOW_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateWorkflowInput {
  userId: string;
  actor: Actor;
  source: WorkflowSource;
  kind: "text" | "document";
  text: string;
  /** Uploaded PDF awaiting background parsing (then `text` is empty). */
  rawBytes?: Uint8Array;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  idempotencyKey?: string;
  /** Present for webhook submissions: enables the durable replay ledger. */
  webhook?: { credentialId: string; signatureHash: string };
}

export interface CreateWorkflowResult {
  id: string;
  duplicate: boolean;
  /** True when an idempotency key was reused with different content. */
  conflict: boolean;
  /** Why a duplicate was detected, for logs/tests. */
  reason?: "replay" | "idempotency_key" | "same_content_window";
}

export async function createWorkflow(deps: WorkflowDeps, input: CreateWorkflowInput): Promise<CreateWorkflowResult> {
  const text = cleanText(input.text).trim();
  if (!text && !input.rawBytes) throw new WorkflowError("BAD_INPUT", "The request contained no text.");
  const contentHash = sha256(input.rawBytes ? Buffer.from(input.rawBytes) : text);
  const { db } = deps;

  const attempt = () =>
    db.$transaction(async (tx): Promise<CreateWorkflowResult> => {
      if (input.webhook) {
        // Serialise concurrent submissions of the same tenant+content so the checks below cannot race.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${contentHash}`}, 0))`;
        const replay = await tx.webhookReceipt.findUnique({ where: { userId_signatureHash: { userId: input.userId, signatureHash: input.webhook.signatureHash } } });
        if (replay?.workflowId) return { id: replay.workflowId, duplicate: true, conflict: false, reason: "replay" };
      }
      if (input.idempotencyKey) {
        const existing = await tx.workflow.findFirst({
          where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
          include: { input: { select: { contentHash: true } } },
        });
        if (existing) return { id: existing.id, duplicate: true, conflict: existing.input?.contentHash !== contentHash, reason: "idempotency_key" };
      }
      if (input.webhook) {
        const since = new Date(deps.now().getTime() - WEBHOOK_CONTENT_WINDOW_MS);
        const recent = await tx.webhookReceipt.findFirst({
          where: { userId: input.userId, contentHash, createdAt: { gte: since }, workflowId: { not: null } },
          orderBy: { createdAt: "asc" },
        });
        if (recent?.workflowId) {
          // Same business request, different signature/idempotency key: another envelope around the same content.
          await tx.webhookReceipt.create({
            data: { userId: input.userId, credentialId: input.webhook.credentialId, signatureHash: input.webhook.signatureHash, contentHash, workflowId: recent.workflowId, createdAt: deps.now() },
          });
          return { id: recent.workflowId, duplicate: true, conflict: false, reason: "same_content_window" };
        }
      }

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
          rawBytes: input.rawBytes ? Buffer.from(input.rawBytes) : null,
        },
      });
      // Enqueued in the SAME transaction: there is no window where a workflow exists without a job.
      await enqueueJob(tx, { userId: input.userId, workflowId: w.id, type: "PROCESS_WORKFLOW", maxAttempts: deps.maxJobAttempts });
      if (input.webhook) {
        await tx.webhookReceipt.create({
          data: { userId: input.userId, credentialId: input.webhook.credentialId, signatureHash: input.webhook.signatureHash, contentHash, workflowId: w.id, createdAt: deps.now() },
        });
      }
      await recordAudit(tx, {
        userId: input.userId,
        workflowId: w.id,
        actor: input.actor,
        eventType: AUDIT.RECEIVED,
        message: `Request received via ${input.source.toLowerCase()}`,
        metadata: { source: input.source, kind: input.kind, sizeBytes: input.sizeBytes ?? Buffer.byteLength(text) },
      });
      return { id: w.id, duplicate: false, conflict: false };
    });

  try {
    return await attempt();
  } catch (err) {
    // Lost a race on a unique constraint (signature ledger or idempotency key): the database decided, re-read.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return attempt();
    throw err;
  }
}

/** Create + run the processing job now (best effort within the inline budget). */
export async function submitWorkflow(deps: WorkflowDeps, input: CreateWorkflowInput): Promise<CreateWorkflowResult> {
  const created = await createWorkflow(deps, input);
  if (!created.duplicate) await runJobInline(deps, { workflowId: created.id, type: "PROCESS_WORKFLOW" });
  return created;
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

const staleMessage = "This request was changed after you opened it. Reload the page and review the latest version.";

export async function editWorkflowFields(
  deps: WorkflowDeps,
  args: { workflowId: string; userId: string; actor: Actor; updates: unknown; expectedVersion?: number },
) {
  const { workflowId, userId, actor } = args;
  const { db } = deps;
  const parsed = editableFieldsSchema.safeParse(args.updates);
  if (!parsed.success) throw new WorkflowError("BAD_INPUT", "Some of the edited values are not valid.");
  const updates = parsed.data;

  const workflow = await loadOwned(db, userId, workflowId);
  if (workflow.status !== "REVIEW_REQUIRED") throw new WorkflowError("INVALID_STATE", "Only workflows awaiting review can be edited.");
  if (!workflow.extracted) throw new WorkflowError("INVALID_STATE", "Nothing to edit yet.");
  if (args.expectedVersion !== undefined && args.expectedVersion !== workflow.version) throw new WorkflowError("STALE_VERSION", staleMessage);

  const current = workflow.extracted.fields as unknown as ExtractedFields;
  const next: ExtractedFields = { ...current, ...updates };
  // An explicit start time supersedes a general window such as "morning".
  if (next.requested_time_start && next.requested_time_window !== "specific") next.requested_time_window = "specific";
  const changes = diffFields(current, next);
  if (changes.length === 0) throw new WorkflowError("NO_CHANGES", "No changes to save.");

  const assessments = structuredClone(workflow.extracted.fieldStatus) as unknown as StoredAssessments;
  const changedFields = new Set(changes.map((c) => c.field));
  for (const { field } of changes) {
    assessments[field as FieldName] = { status: "known", confidence: "high", evidence: null, note: "Set by a human reviewer.", edited: true, verified: true, span: null };
  }
  // Supplying a phone number resolves the "named contact but no way to reach them" concern.
  if (changedFields.has("contact_phone") && next.contact_phone && next.contact_name && !changedFields.has("contact_name")) {
    assessments.contact_name = { ...assessments.contact_name, confidence: "high", note: null };
  }
  const ambiguities = (workflow.extracted.ambiguities as unknown as Extraction["ambiguities"]).filter((a) => !changedFields.has(a.field));

  const validation = await computeValidation(deps, userId, workflowId, next);
  const decision = decideReview({
    requiresHumanReview: false,
    assessments,
    ambiguities,
    validation,
  });

  // ONE transaction: fields, version bump, validation and audit are committed together or not at all.
  // The version predicate makes a concurrent edit/approval lose cleanly instead of overwriting.
  await db.$transaction(async (tx) => {
    assertPath("REVIEW_REQUIRED", "VALIDATING", "REVIEW_REQUIRED");
    const { count } = await tx.workflow.updateMany({
      where: { id: workflowId, userId, status: "REVIEW_REQUIRED", version: workflow.version },
      data: {
        version: { increment: 1 },
        ...duplicateKeys(next),
        overallConfidence: decision.overallConfidence,
        needsAttention: decision.needsAttention,
        attentionReason: decision.needsAttention ? (decision.reasons[0] ?? null) : null,
      },
    });
    if (count !== 1) throw new WorkflowError("STALE_VERSION", staleMessage);
    await tx.extractedData.update({ where: { workflowId }, data: { fields: json(next), fieldStatus: json(assessments), ambiguities: json(ambiguities) } });
    await tx.validationResult.create({
      data: { workflowId, userId, passed: validation.passed, errorCount: validation.errorCount, warningCount: validation.warningCount, issues: json(validation.issues) },
    });
    await recordAudit(tx, {
      userId,
      workflowId,
      actor,
      eventType: AUDIT.FIELDS_EDITED,
      message: `Edited ${changes.map((c) => c.field.replaceAll("_", " ")).join(", ")}`,
      metadata: { fromVersion: workflow.version, changes: changes.map((c) => ({ field: c.field, from: auditValue(c.field, c.from), to: auditValue(c.field, c.to) })) },
    });
    await recordAudit(tx, {
      userId,
      workflowId,
      actor: { type: "SYSTEM" },
      eventType: AUDIT.VALIDATION_COMPLETED,
      message: validation.passed ? `Validation completed (${validation.warningCount} warning${validation.warningCount === 1 ? "" : "s"})` : `Validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}`,
      metadata: { errors: validation.errorCount, warnings: validation.warningCount, codes: validation.issues.map((i) => i.code) },
    });
  });
  return { changes, validation, version: workflow.version + 1 };
}

export async function rejectWorkflow(
  deps: WorkflowDeps,
  args: { workflowId: string; userId: string; actor: Actor; comment?: string; expectedVersion?: number },
) {
  const { workflowId, userId, actor } = args;
  const workflow = await loadOwned(deps.db, userId, workflowId);
  if (workflow.status !== "REVIEW_REQUIRED") throw new WorkflowError("INVALID_STATE", "Only workflows awaiting review can be rejected.");
  if (args.expectedVersion !== undefined && args.expectedVersion !== workflow.version) throw new WorkflowError("STALE_VERSION", staleMessage);
  const comment = args.comment?.trim().slice(0, 1000) || null;
  await deps.db.$transaction(async (tx) => {
    await transition(tx, { workflowId, userId, from: "REVIEW_REQUIRED", to: "REJECTED", data: { needsAttention: false, attentionReason: null } });
    await tx.review.create({
      data: { workflowId, userId, reviewerId: "id" in actor ? actor.id : userId, decision: "REJECTED", comment, changes: json([]) },
    });
    await recordAudit(tx, { userId, workflowId, actor, eventType: AUDIT.REJECTED, message: "Request rejected", metadata: { hasComment: Boolean(comment) } });
  });
}

/** Errors that block approval are re-derived from scratch, never trusted from a stored result. */
export async function currentValidation(deps: WorkflowDeps, userId: string, workflowId: string): Promise<ValidationOutcome> {
  const extracted = await deps.db.extractedData.findFirstOrThrow({ where: { workflowId, userId } });
  return computeValidation(deps, userId, workflowId, extracted.fields as unknown as ExtractedFields);
}

export const actionKey = (workflowId: string, version: number) => `wf:${workflowId}:customer_confirmation:v${version}`;

/**
 * Approve exactly the version the reviewer saw.
 *
 * `expectedVersion` is mandatory: the approval commits only if the workflow is still at that version (the
 * predicate is part of the same UPDATE that flips the status, so a concurrent edit cannot slip in between the
 * check and the approval). A frozen snapshot of the approved fields is stored and is what the action executes.
 */
export async function approveWorkflow(
  deps: WorkflowDeps,
  args: { workflowId: string; userId: string; actor: Actor; expectedVersion: number; comment?: string; run?: boolean },
) {
  const { workflowId, userId, actor, expectedVersion } = args;
  if (!Number.isInteger(expectedVersion)) throw new WorkflowError("BAD_INPUT", "Missing version. Reload the page and try again.");
  const workflow = await loadOwned(deps.db, userId, workflowId);
  if (workflow.status !== "REVIEW_REQUIRED") throw new WorkflowError("INVALID_STATE", "Only workflows awaiting review can be approved.");
  if (!workflow.extracted) throw new WorkflowError("INVALID_STATE", "Nothing to approve yet.");
  if (workflow.version !== expectedVersion) throw new WorkflowError("STALE_VERSION", staleMessage);

  const fields = workflow.extracted.fields as unknown as ExtractedFields;
  const validation = await computeValidation(deps, userId, workflowId, fields);
  if (!validation.passed) {
    throw new WorkflowError("VALIDATION_FAILED", `Fix ${validation.errorCount} validation error${validation.errorCount === 1 ? "" : "s"} before approving.`);
  }

  const original = (workflow.extracted.aiOutput as unknown as Extraction).fields;
  const changes = diffFields(original, fields);
  const comment = args.comment?.trim().slice(0, 1000) || null;
  const reviewerId = "id" in actor ? actor.id : userId;

  try {
    await deps.db.$transaction(async (tx) => {
      assertPath("REVIEW_REQUIRED", "APPROVED");
      const { count } = await tx.workflow.updateMany({
        where: { id: workflowId, userId, status: "REVIEW_REQUIRED", version: expectedVersion },
        data: { status: "APPROVED", needsAttention: false, attentionReason: null },
      });
      if (count !== 1) throw new WorkflowError("STALE_VERSION", staleMessage);
      await tx.review.create({
        data: {
          workflowId,
          userId,
          reviewerId,
          decision: "APPROVED",
          comment,
          approvedVersion: expectedVersion,
          approvedFields: json(fields),
          changes: json(changes.map((c) => ({ field: c.field, from: auditValue(c.field, c.from), to: auditValue(c.field, c.to) }))),
        },
      });
      // Outbox row: created with the approval, so "approved" and "action owed" can never diverge.
      await tx.workflowAction.create({
        data: {
          workflowId,
          userId,
          type: "CUSTOMER_CONFIRMATION",
          status: "PENDING",
          mode: deps.actions.mode,
          executedBy: reviewerId,
          idempotencyKey: actionKey(workflowId, expectedVersion),
        },
      });
      await enqueueJob(tx, { userId, workflowId, type: "EXECUTE_ACTION", maxAttempts: deps.maxJobAttempts });
      await recordAudit(tx, {
        userId,
        workflowId,
        actor,
        eventType: AUDIT.APPROVED,
        message: changes.length ? `Request approved with ${changes.length} edited field${changes.length === 1 ? "" : "s"}` : "Request approved",
        metadata: { approvedVersion: expectedVersion, editedFields: changes.map((c) => c.field) },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new WorkflowError("CONFLICT", "This workflow was already reviewed.");
    throw err;
  }
  if (args.run !== false) await runJobInline(deps, { workflowId, type: "EXECUTE_ACTION" });
  return deps.db.workflow.findFirstOrThrow({ where: { id: workflowId, userId } });
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Recover a workflow. Safe to call repeatedly and concurrently:
 *   FAILED (approved)   → re-queue the action (same idempotency key)
 *   FAILED (unapproved) → re-queue processing
 *   RECEIVED / APPROVED → make sure a job exists (repairs a stranded workflow)
 */
export async function retryWorkflow(deps: WorkflowDeps, args: { workflowId: string; userId: string; actor: Actor; run?: boolean }) {
  const { workflowId, userId, actor } = args;
  const workflow = await loadOwned(deps.db, userId, workflowId);
  const approved = await deps.db.review.findFirst({ where: { workflowId, userId, decision: "APPROVED" }, select: { id: true } });

  let type: "PROCESS_WORKFLOW" | "EXECUTE_ACTION" = "PROCESS_WORKFLOW";
  if (workflow.status === "FAILED") type = approved ? "EXECUTE_ACTION" : "PROCESS_WORKFLOW";
  else if (workflow.status === "RECEIVED") type = "PROCESS_WORKFLOW";
  else if (workflow.status === "APPROVED" && approved) type = "EXECUTE_ACTION";
  else throw new WorkflowError("INVALID_STATE", "Only failed or stalled workflows can be retried.");

  await deps.db.$transaction(async (tx) => {
    if (workflow.status === "FAILED") {
      await transition(tx, {
        workflowId,
        userId,
        from: "FAILED",
        to: approved ? "APPROVED" : "RECEIVED",
        data: { failureReason: null, needsAttention: false, attentionReason: null },
      });
      if (approved) await tx.workflowAction.updateMany({ where: { workflowId, status: "FAILED" }, data: { status: "PENDING", error: null } });
    }
    await enqueueJob(tx, { userId, workflowId, type, maxAttempts: deps.maxJobAttempts });
    await recordAudit(tx, { userId, workflowId, actor, eventType: AUDIT.RETRY_REQUESTED, message: "Retry requested" });
  });
  if (args.run !== false) await runJobInline(deps, { workflowId, type });
  return deps.db.workflow.findFirstOrThrow({ where: { id: workflowId, userId } });
}
