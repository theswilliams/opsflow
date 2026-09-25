import type { JobType } from "@/generated/prisma/enums";
import { logger } from "@/lib/logger";
import { AUDIT, recordAudit } from "@/lib/workflow/audit";
import { errorMessage, type WorkflowDeps } from "@/lib/workflow/core";
import { executeActionJob } from "@/lib/workflow/execution";
import { processWorkflowJob } from "@/lib/workflow/processing";
import { purgeExpiredContent } from "@/lib/privacy";
import { claimJob, enqueueJob, type ClaimedJob } from "./queue";

async function run(deps: WorkflowDeps, job: ClaimedJob): Promise<void> {
  try {
    if (job.type === "PROCESS_WORKFLOW") await processWorkflowJob(deps, job);
    else await executeActionJob(deps, job);
  } catch (err) {
    // Handlers contain their own failure handling; anything reaching here (e.g. database outage) leaves the
    // lease to expire, and the sweeper re-queues or fails the job. It is never silently lost.
    logger.error("job.unhandled", { jobId: job.id, type: job.type, error: err });
  }
}

/** Claims and runs at most `max` due jobs. Returns how many ran. */
export async function drainJobs(deps: WorkflowDeps, max = 10): Promise<number> {
  let ran = 0;
  while (ran < max) {
    const job = await claimJob(deps.db, { workerId: deps.workerId, leaseMs: deps.leaseMs, now: deps.now() });
    if (!job) break;
    await run(deps, job);
    ran++;
  }
  return ran;
}

/**
 * Runs one specific workflow job now if it is due and unclaimed (used by user-facing requests so the UI stays
 * snappy). Waits up to `inlineTimeoutMs`; if the job takes longer the request returns and the job carries on
 * under its lease — a platform timeout at worst expires the lease, after which the sweeper recovers it.
 */
export async function runJobInline(deps: WorkflowDeps, args: { workflowId: string; type: JobType }): Promise<void> {
  const job = await claimJob(deps.db, { workerId: deps.workerId, leaseMs: deps.leaseMs, now: deps.now(), workflowId: args.workflowId, type: args.type });
  if (!job) return; // someone else has it (or it is not due yet)
  const running = run(deps, job);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([running, new Promise<void>((resolve) => (timer = setTimeout(resolve, deps.inlineTimeoutMs)))]);
  clearTimeout(timer);
}

export interface SweepResult {
  requeued: number;
  failed: number;
  reenqueued: number;
}

const WORKING = ["RECEIVED", "PROCESSING", "EXTRACTED", "VALIDATING"] as const;

/**
 * Recovery. Guarantees that no workflow sits in a working state without a live job:
 *   1. RUNNING jobs whose lease expired → back to QUEUED (or FAILED once attempts are exhausted), with the
 *      workflow moved back to a retryable state in the same transaction.
 *   2. Working/approved workflows with NO active job (crash between steps, legacy rows) → a job is enqueued.
 * Every step is idempotent and safe to run from many workers at once.
 */
export async function sweepStuckWork(deps: WorkflowDeps): Promise<SweepResult> {
  const { db } = deps;
  const now = deps.now();
  const result: SweepResult = { requeued: 0, failed: 0, reenqueued: 0 };

  const expired = await db.job.findMany({ where: { status: "RUNNING", leaseExpiresAt: { lt: now } }, take: 100, orderBy: { leaseExpiresAt: "asc" } });
  for (const job of expired) {
    await db.$transaction(async (tx) => {
      // Re-check under the row lock: only act if it is still the same expired attempt.
      const still = await tx.job.updateMany({
        where: { id: job.id, status: "RUNNING", attempts: job.attempts, leaseExpiresAt: { lt: now } },
        data: job.attempts >= job.maxAttempts
          ? { status: "FAILED", finishedAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: "lease expired; attempts exhausted" }
          : { status: "QUEUED", runAfter: now, leaseOwner: null, leaseExpiresAt: null, lastError: "lease expired" },
      });
      if (still.count !== 1) return;
      const exhausted = job.attempts >= job.maxAttempts;
      const base = { id: job.workflowId, userId: job.userId };
      if (job.type === "PROCESS_WORKFLOW") {
        const to = exhausted ? { status: "FAILED" as const, failureReason: "Processing did not complete. Use Retry.", needsAttention: true, attentionReason: "Processing did not complete" } : { status: "RECEIVED" as const };
        const moved = await tx.workflow.updateMany({ where: { ...base, status: { in: ["PROCESSING", "EXTRACTED", "VALIDATING"] } }, data: to });
        if (moved.count) await recordAudit(tx, { userId: job.userId, workflowId: job.workflowId, actor: { type: "SYSTEM" }, eventType: exhausted ? AUDIT.FAILED : AUDIT.PROCESSING_RETRY, message: exhausted ? "Processing did not complete after repeated attempts" : "Processing lease expired; re-queued", metadata: { attempts: job.attempts } });
      } else {
        const to = exhausted ? { status: "FAILED" as const, failureReason: "The automated action could not be confirmed. Retrying is safe: the same idempotency key is reused.", needsAttention: true, attentionReason: "Action not confirmed" } : { status: "APPROVED" as const };
        const moved = await tx.workflow.updateMany({ where: { ...base, status: "EXECUTING" }, data: to });
        if (moved.count) {
          if (exhausted) await tx.workflowAction.updateMany({ where: { workflowId: job.workflowId, status: "EXECUTING" }, data: { status: "FAILED", error: "Action not confirmed" } });
          await recordAudit(tx, { userId: job.userId, workflowId: job.workflowId, actor: { type: "SYSTEM" }, eventType: exhausted ? AUDIT.ACTION_FAILED : AUDIT.PROCESSING_RETRY, message: exhausted ? "Action could not be confirmed after repeated attempts" : "Action lease expired; re-queued", metadata: { attempts: job.attempts } });
        }
      }
      if (exhausted) result.failed++;
      else result.requeued++;
    });
  }

  // Orphans: a working state with no live job (e.g. crash after the workflow row was written but before enqueue).
  const cutoff = new Date(now.getTime() - deps.orphanGraceMs);
  const orphans = await db.workflow.findMany({
    where: {
      updatedAt: { lt: cutoff },
      OR: [
        { status: { in: [...WORKING] }, jobs: { none: { type: "PROCESS_WORKFLOW", status: { in: ["QUEUED", "RUNNING"] } } } },
        { status: { in: ["APPROVED", "EXECUTING"] }, jobs: { none: { type: "EXECUTE_ACTION", status: { in: ["QUEUED", "RUNNING"] } } } },
      ],
    },
    take: 100,
    select: { id: true, userId: true, status: true },
  });
  for (const w of orphans) {
    const isExecute = w.status === "APPROVED" || w.status === "EXECUTING";
    await db.$transaction(async (tx) => {
      if (isExecute) {
        if (w.status === "EXECUTING") await tx.workflow.updateMany({ where: { id: w.id, userId: w.userId, status: "EXECUTING" }, data: { status: "APPROVED" } });
        await enqueueJob(tx, { userId: w.userId, workflowId: w.id, type: "EXECUTE_ACTION", maxAttempts: deps.maxJobAttempts });
      } else {
        if (w.status !== "RECEIVED") await tx.workflow.updateMany({ where: { id: w.id, userId: w.userId, status: w.status }, data: { status: "RECEIVED" } });
        await enqueueJob(tx, { userId: w.userId, workflowId: w.id, type: "PROCESS_WORKFLOW", maxAttempts: deps.maxJobAttempts });
      }
      await recordAudit(tx, { userId: w.userId, workflowId: w.id, actor: { type: "SYSTEM" }, eventType: AUDIT.PROCESSING_RETRY, message: "Recovered an orphaned workflow", metadata: { from: w.status } });
      result.reenqueued++;
    }).catch((e) => logger.warn("sweep.orphan_failed", { workflowId: w.id, error: errorMessage(e) }));
  }

  if (result.requeued || result.failed || result.reenqueued) logger.info("sweep.recovered", { ...result });
  return result;
}

/** Long-running poller for the in-process worker (and `npm run worker`). Returns a stop function. */
export function startWorkerLoop(deps: WorkflowDeps, options: { pollMs?: number; sweepMs?: number } = {}): () => void {
  const { pollMs = 2_000, sweepMs = 30_000 } = options;
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await drainJobs(deps, 5);
    } catch (e) {
      logger.error("worker.tick_failed", { error: e });
    } finally {
      busy = false;
    }
  };
  let lastPurge = 0;
  const sweep = () => {
    void sweepStuckWork(deps).catch((e) => logger.error("worker.sweep_failed", { error: e }));
    if (Date.now() - lastPurge > 6 * 3_600_000) {
      lastPurge = Date.now();
      void purgeExpiredContent(deps.db, { retentionDays: deps.retentionDays, now: deps.now() }).catch((e) => logger.error("worker.purge_failed", { error: e }));
    }
  };
  const poll = setInterval(tick, pollMs);
  const sweeper = setInterval(sweep, sweepMs);
  poll.unref?.();
  sweeper.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(sweeper);
  };
}
