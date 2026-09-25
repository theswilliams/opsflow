import type { Prisma } from "@/generated/prisma/client";
import { extractWorkflowData, ExtractionError, type ExtractionOutcome } from "@/lib/ai/extract";
import type { Extraction, ExtractedFields, FieldAssessments } from "@/lib/ai/schema";
import { assertWithinBudget, recordUsage } from "@/lib/ai/usage";
import { todayIn } from "@/lib/dates";
import { DocumentError, parsePdfBytes } from "@/lib/documents/extract";
import { assertLease, finishJob, LeaseLostError, requeueJob, type ClaimedJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { decideReview } from "@/lib/validation/rules";
import { AUDIT, recordAudit } from "./audit";
import { computeValidation, duplicateKeys, errorMessage, type WorkflowDeps } from "./core";
import { assertPath } from "./state-machine";

const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Background job: RECEIVED → (parse document) → AI extraction → validation → REVIEW_REQUIRED.
 *
 * Crash-safety contract:
 *  - PROCESSING is the only long-lived working state and it is protected by the job lease.
 *  - Everything after the slow AI call is ONE transaction (extraction data, validation result, status,
 *    audit, notification, job completion). There is no window in which EXTRACTED / VALIDATING can be stranded.
 *  - Every write is fenced by the job's lease token, so a worker that lost its lease cannot overwrite newer state.
 */
export async function processWorkflowJob(deps: WorkflowDeps, job: ClaimedJob): Promise<void> {
  const { db } = deps;
  const { userId, workflowId } = job;
  const started = Date.now();

  const workflow = await db.workflow.findFirst({ where: { id: workflowId, userId }, include: { input: true } });
  if (!workflow?.input) {
    await db.$transaction((tx) => finishJob(tx, job, "FAILED", deps.now(), "workflow or input missing"));
    return;
  }
  if (workflow.status !== "RECEIVED") {
    // Already processed (duplicate delivery / recovered elsewhere): nothing to do.
    await db.$transaction((tx) => finishJob(tx, job, "SUCCEEDED", deps.now(), `noop: status ${workflow.status}`));
    return;
  }

  try {
    await db.$transaction(async (tx) => {
      await assertLease(tx, job, deps.now());
      const { count } = await tx.workflow.updateMany({ where: { id: workflowId, userId, status: "RECEIVED" }, data: { status: "PROCESSING", failureReason: null } });
      if (count !== 1) throw new LeaseLostError();
    });

    let text = workflow.input.content;
    if (workflow.input.rawBytes) {
      text = await parsePdfBytes(workflow.input.rawBytes, deps.pdf);
      await db.$transaction(async (tx) => {
        await assertLease(tx, job, deps.now());
        await tx.workflowInput.update({ where: { workflowId }, data: { content: text, rawBytes: null } });
      });
    }

    const referenceDate = todayIn(deps.timezone, deps.now());
    let provider;
    try {
      provider = deps.ai();
    } catch (e) {
      // A missing/invalid provider configuration is deterministic: fail clearly instead of retrying.
      throw new ExtractionError("PROVIDER_FAILED", "The AI provider is not configured correctly. Contact an administrator.", { cause: e, retryable: false });
    }
    const outcome = await extractWorkflowData(
      provider,
      { text, referenceDate },
      {
        ...deps.extraction,
        beforeAttempt: async () => {
          await assertWithinBudget(db, userId, deps.budget, deps.now());
        },
        onAttempt: (usage) => recordUsage(db, { userId, workflowId, provider: provider.name, usage, prices: deps.prices, now: deps.now() }),
      },
    );

    await persistExtraction(deps, job, outcome);
    logger.info("workflow.processed", { workflowId, durationMs: Date.now() - started, provider: outcome.provider, attempt: job.attempts, result: "review_required" });
  } catch (err) {
    if (err instanceof LeaseLostError) {
      logger.warn("workflow.lease_lost", { workflowId, jobId: job.id });
      return;
    }
    await handleFailure(deps, job, err);
  }
}

async function persistExtraction(deps: WorkflowDeps, job: ClaimedJob, outcome: ExtractionOutcome) {
  const { db } = deps;
  const { userId, workflowId } = job;
  const e = outcome.extraction;
  const fields = e.fields as ExtractedFields;
  const assessments = e.field_assessments as unknown as FieldAssessments;
  const validation = await computeValidation(deps, userId, workflowId, fields);
  const decision = decideReview({
    requiresHumanReview: e.requires_human_review,
    aiReason: e.reason,
    assessments,
    ambiguities: e.ambiguities as Extraction["ambiguities"],
    validation,
  });
  const data = {
    provider: outcome.provider,
    model: outcome.model,
    attempts: outcome.attempts,
    aiOutput: json(e),
    fields: json(e.fields),
    fieldStatus: json(e.field_assessments),
    missingInformation: json(e.missing_information),
    ambiguities: json(e.ambiguities),
    requiresHumanReview: e.requires_human_review,
    reason: e.reason,
    recommendedAction: e.recommended_action,
  };
  const now = deps.now();

  await db.$transaction(async (tx) => {
    await assertLease(tx, job, now);
    // The state machine stays authoritative even though the hops are committed together.
    assertPath("PROCESSING", "EXTRACTED", "VALIDATING", "REVIEW_REQUIRED");
    const { count } = await tx.workflow.updateMany({
      where: { id: workflowId, userId, status: "PROCESSING" },
      data: {
        status: "REVIEW_REQUIRED",
        ...duplicateKeys(fields),
        overallConfidence: decision.overallConfidence,
        needsAttention: decision.needsAttention,
        attentionReason: decision.needsAttention ? (decision.reasons[0] ?? null) : null,
        failureReason: null,
        reviewRequiredAt: now,
        version: { increment: 1 },
      },
    });
    if (count !== 1) throw new LeaseLostError();

    await tx.extractedData.upsert({ where: { workflowId }, create: { workflowId, userId, ...data }, update: data });
    await tx.validationResult.create({
      data: { workflowId, userId, passed: validation.passed, errorCount: validation.errorCount, warningCount: validation.warningCount, issues: json(validation.issues) },
    });

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
    await recordAudit(tx, {
      userId,
      workflowId,
      actor: { type: "SYSTEM" },
      eventType: AUDIT.REVIEW_REQUIRED,
      message: decision.needsAttention ? "Human review required" : "Ready for human approval",
      metadata: { needsAttention: decision.needsAttention, reasons: decision.reasons.slice(0, 6) },
    });
    // Simulated notification: a real deployment would email/Slack the review queue here.
    await tx.notification.create({
      data: {
        userId,
        workflowId,
        kind: "REVIEW_REQUIRED",
        message: `${fields.customer ?? "A new request"} needs review${decision.needsAttention && decision.reasons[0] ? `: ${decision.reasons[0]}` : ""}`.slice(0, 300),
      },
    });
    await finishJob(tx, job, "SUCCEEDED", now);
  });
}

async function handleFailure(deps: WorkflowDeps, job: ClaimedJob, err: unknown) {
  const { db } = deps;
  const { userId, workflowId } = job;
  const now = deps.now();

  // Deterministic failures are terminal; transient ones retry with backoff until attempts run out.
  let userMessage: string;
  let terminal: boolean;
  let code: string;
  if (err instanceof DocumentError) {
    [userMessage, terminal, code] = [err.userMessage, true, "DOCUMENT"];
  } else if (err instanceof ExtractionError) {
    [userMessage, terminal, code] = [err.userMessage, !err.retryable, err.code];
  } else {
    logger.error("workflow.process_failed", { workflowId, jobId: job.id, error: err });
    [userMessage, terminal, code] = ["Processing failed unexpectedly.", false, "INTERNAL"];
  }
  const exhausted = job.attempts >= job.maxAttempts;

  try {
    await db.$transaction(async (tx) => {
      await assertLease(tx, job, now);
      if (terminal || exhausted) {
        const reason = !terminal && exhausted ? `${userMessage} Gave up after ${job.attempts} attempts — use Retry.` : userMessage;
        assertPath("PROCESSING", "FAILED");
        // A rejected upload keeps no bytes around.
        if (err instanceof DocumentError) await tx.workflowInput.update({ where: { workflowId }, data: { rawBytes: null } });
        await tx.workflow.updateMany({ where: { id: workflowId, userId, status: "PROCESSING" }, data: { status: "FAILED", failureReason: reason, needsAttention: true, attentionReason: reason } });
        await recordAudit(tx, { userId, workflowId, actor: { type: "SYSTEM" }, eventType: AUDIT.EXTRACTION_FAILED, message: reason, metadata: { code, attempts: job.attempts } });
        await finishJob(tx, job, "FAILED", now, `${code}: ${errorMessage(err)}`);
      } else {
        assertPath("PROCESSING", "RECEIVED");
        await tx.workflow.updateMany({ where: { id: workflowId, userId, status: "PROCESSING" }, data: { status: "RECEIVED" } });
        await recordAudit(tx, {
          userId,
          workflowId,
          actor: { type: "SYSTEM" },
          eventType: AUDIT.PROCESSING_RETRY,
          message: `Processing attempt ${job.attempts} of ${job.maxAttempts} failed; will retry`,
          metadata: { code },
        });
        await requeueJob(tx, job, { now, delayMs: deps.retryBackoffMs * job.attempts, error: `${code}: ${errorMessage(err)}` });
      }
    });
  } catch (e) {
    // If even this fails (e.g. database outage) the lease simply expires and the sweeper takes over.
    if (!(e instanceof LeaseLostError)) logger.error("workflow.failure_handler_failed", { workflowId, jobId: job.id, error: e });
  }
}
