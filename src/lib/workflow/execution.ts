import type { Prisma } from "@/generated/prisma/client";
import type { ExtractedFields } from "@/lib/ai/schema";
import { assertLease, finishJob, LeaseLostError, requeueJob, type ClaimedJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { ActionError } from "./action-provider";
import { AUDIT, recordAudit } from "./audit";
import { errorMessage, type WorkflowDeps } from "./core";
import { assertPath } from "./state-machine";

const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Outbox executor for the customer action.
 *
 * Order of operations (the important part):
 *   1. tx: workflow APPROVED → EXECUTING, action → EXECUTING          (durable "I am about to send")
 *   2. call the provider WITH the action's deterministic idempotency key   (the only external side effect)
 *   3. tx: action → SUCCEEDED, workflow → COMPLETED, job done
 *
 * If step 3 (or anything after step 2) fails, the action row stays EXECUTING and the job is retried. The retry
 * calls the provider again with the SAME idempotency key, so a provider that honours idempotency performs the
 * side effect once. A database unique index alone could not do this: it fires only after the email has been sent.
 */
export async function executeActionJob(deps: WorkflowDeps, job: ClaimedJob): Promise<void> {
  const { db } = deps;
  const { userId, workflowId } = job;

  const [workflow, review, action] = await Promise.all([
    db.workflow.findFirst({ where: { id: workflowId, userId } }),
    db.review.findFirst({ where: { workflowId, userId, decision: "APPROVED" } }),
    db.workflowAction.findUnique({ where: { workflowId_type: { workflowId, type: "CUSTOMER_CONFIRMATION" } } }),
  ]);

  // Hard boundary: no persisted human approval (with a frozen snapshot), no external action.
  if (!workflow || !review?.approvedFields || !action) {
    await db.$transaction((tx) => finishJob(tx, job, "FAILED", deps.now(), "approval or action record missing"));
    logger.error("workflow.execute_without_approval", { workflowId });
    return;
  }
  if (action.status === "SUCCEEDED" && workflow.status === "COMPLETED") {
    await db.$transaction((tx) => finishJob(tx, job, "SUCCEEDED", deps.now(), "noop: already completed"));
    return;
  }
  if (workflow.status !== "APPROVED" && workflow.status !== "EXECUTING") {
    await db.$transaction((tx) => finishJob(tx, job, "SUCCEEDED", deps.now(), `noop: status ${workflow.status}`));
    return;
  }

  const fields = review.approvedFields as unknown as ExtractedFields;
  const started = Date.now();

  try {
    await db.$transaction(async (tx) => {
      await assertLease(tx, job, deps.now());
      if (workflow.status === "APPROVED") {
        assertPath("APPROVED", "EXECUTING");
        const { count } = await tx.workflow.updateMany({ where: { id: workflowId, userId, status: "APPROVED" }, data: { status: "EXECUTING", failureReason: null } });
        if (count !== 1) throw new LeaseLostError();
      }
      await tx.workflowAction.update({ where: { id: action.id }, data: { status: "EXECUTING", attempts: { increment: 1 }, error: null } });
    });

    const result = await deps.actions.execute({ workflowId, fields }, { idempotencyKey: action.idempotencyKey });

    await db.$transaction(async (tx) => {
      await assertLease(tx, job, deps.now());
      assertPath("EXECUTING", "COMPLETED");
      const { count } = await tx.workflow.updateMany({ where: { id: workflowId, userId, status: "EXECUTING" }, data: { status: "COMPLETED", needsAttention: false, attentionReason: null } });
      if (count !== 1) throw new LeaseLostError();
      await tx.workflowAction.update({ where: { id: action.id }, data: { status: "SUCCEEDED", output: json(result), error: null } });
      await recordAudit(tx, {
        userId,
        workflowId,
        actor: { type: "SYSTEM" },
        eventType: AUDIT.ACTION_EXECUTED,
        message: deps.actions.mode === "simulated" ? "Customer confirmation generated (simulated)" : "Customer confirmation sent",
        metadata: { provider: deps.actions.name, mode: deps.actions.mode, durationMs: Date.now() - started, attempts: job.attempts, idempotencyKey: action.idempotencyKey },
      });
      await recordAudit(tx, { userId, workflowId, actor: { type: "SYSTEM" }, eventType: AUDIT.COMPLETED, message: "Workflow completed" });
      await finishJob(tx, job, "SUCCEEDED", deps.now());
    });
  } catch (err) {
    if (err instanceof LeaseLostError) {
      logger.warn("workflow.lease_lost", { workflowId, jobId: job.id });
      return;
    }
    await handleFailure(deps, job, action.id, err);
  }
}

async function handleFailure(deps: WorkflowDeps, job: ClaimedJob, actionId: string, err: unknown) {
  const { db } = deps;
  const { userId, workflowId } = job;
  const now = deps.now();
  const definitive = err instanceof ActionError; // the provider itself told us it did NOT send
  const userMessage = err instanceof ActionError ? err.userMessage : "The automated action could not be confirmed.";
  if (!definitive) logger.error("workflow.action_failed", { workflowId, jobId: job.id, error: err });
  const exhausted = job.attempts >= job.maxAttempts;

  try {
    await db.$transaction(async (tx) => {
      await assertLease(tx, job, now);
      if (definitive || exhausted) {
        const reason = definitive ? userMessage : `${userMessage} Retrying is safe: the same idempotency key is reused.`;
        assertPath("EXECUTING", "FAILED");
        await tx.workflow.updateMany({ where: { id: workflowId, userId, status: "EXECUTING" }, data: { status: "FAILED", failureReason: reason, needsAttention: true, attentionReason: reason } });
        await tx.workflowAction.update({ where: { id: actionId }, data: { status: "FAILED", error: reason } });
        await recordAudit(tx, { userId, workflowId, actor: { type: "SYSTEM" }, eventType: AUDIT.ACTION_FAILED, message: `Automated action failed: ${reason}`, metadata: { attempts: job.attempts } });
        await finishJob(tx, job, "FAILED", now, errorMessage(err));
      } else {
        assertPath("EXECUTING", "APPROVED");
        await tx.workflow.updateMany({ where: { id: workflowId, userId, status: "EXECUTING" }, data: { status: "APPROVED" } });
        await recordAudit(tx, { userId, workflowId, actor: { type: "SYSTEM" }, eventType: AUDIT.PROCESSING_RETRY, message: `Action attempt ${job.attempts} of ${job.maxAttempts} was not confirmed; will retry with the same idempotency key` });
        await requeueJob(tx, job, { now, delayMs: deps.retryBackoffMs * job.attempts, error: errorMessage(err) });
      }
    });
  } catch (e) {
    if (!(e instanceof LeaseLostError)) logger.error("workflow.failure_handler_failed", { workflowId, jobId: job.id, error: e });
  }
}
