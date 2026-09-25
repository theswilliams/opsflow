import { Prisma } from "@/generated/prisma/client";
import type { JobType } from "@/generated/prisma/enums";
import type { Db } from "@/lib/db";

/**
 * Durable job queue on PostgreSQL.
 *
 *  - One row per (workflow, type). A retry re-queues the same row.
 *  - `claimJob` takes a lease with `FOR UPDATE SKIP LOCKED`, so concurrent workers never share a job.
 *  - `attempts` is the fencing token: it increments on every claim, so a worker whose lease was reclaimed
 *    holds a stale token and every write it makes through `assertLease` / `finishJob` / `requeueJob` fails.
 */
type Client = Db | Prisma.TransactionClient;

export interface ClaimedJob {
  id: string;
  workflowId: string;
  userId: string;
  type: JobType;
  attempts: number;
  maxAttempts: number;
  workerId: string;
}

export class LeaseLostError extends Error {
  constructor() {
    super("Job lease lost");
    this.name = "LeaseLostError";
  }
}

export async function enqueueJob(
  client: Client,
  args: { userId: string; workflowId: string; type: JobType; maxAttempts: number; resetAttempts?: boolean; runAfter?: Date },
) {
  const existing = await client.job.findUnique({ where: { workflowId_type: { workflowId: args.workflowId, type: args.type } } });
  if (!existing) {
    return client.job.create({
      data: { userId: args.userId, workflowId: args.workflowId, type: args.type, maxAttempts: args.maxAttempts, runAfter: args.runAfter ?? new Date() },
    });
  }
  // Already waiting or running: idempotent no-op.
  if (existing.status === "QUEUED" || existing.status === "RUNNING") return existing;
  return client.job.update({
    where: { id: existing.id },
    data: {
      status: "QUEUED",
      runAfter: args.runAfter ?? new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
      lastError: null,
      maxAttempts: args.maxAttempts,
      ...(args.resetAttempts === false ? {} : { attempts: 0 }),
    },
  });
}

interface ClaimRow {
  id: string;
  workflowId: string;
  userId: string;
  type: JobType;
  attempts: number;
  maxAttempts: number;
}

export async function claimJob(
  db: Db,
  args: { workerId: string; leaseMs: number; now: Date; workflowId?: string; type?: JobType },
): Promise<ClaimedJob | null> {
  const leaseUntil = new Date(args.now.getTime() + args.leaseMs);
  const filter = Prisma.sql`${args.workflowId ? Prisma.sql`AND "workflowId" = ${args.workflowId}` : Prisma.empty} ${
    args.type ? Prisma.sql`AND "type" = ${args.type}::"JobType"` : Prisma.empty
  }`;
  const rows = await db.$queryRaw<ClaimRow[]>(Prisma.sql`
    UPDATE "Job" SET
      "status" = 'RUNNING', "leaseOwner" = ${args.workerId}, "leaseExpiresAt" = ${leaseUntil},
      "attempts" = "attempts" + 1, "updatedAt" = ${args.now}
    WHERE "id" = (
      SELECT "id" FROM "Job"
      WHERE "status" = 'QUEUED' AND "runAfter" <= ${args.now} ${filter}
      ORDER BY "runAfter" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "workflowId", "userId", "type"::text AS "type", "attempts", "maxAttempts"`);
  const row = rows[0];
  return row ? { ...row, workerId: args.workerId } : null;
}

/** Throws LeaseLostError unless this worker still holds the job at this fencing token. */
export async function assertLease(tx: Client, job: ClaimedJob, now: Date = new Date()) {
  const { count } = await tx.job.updateMany({
    where: { id: job.id, leaseOwner: job.workerId, attempts: job.attempts, status: "RUNNING" },
    data: { updatedAt: now },
  });
  if (count !== 1) throw new LeaseLostError();
}

export async function extendLease(db: Db, job: ClaimedJob, leaseMs: number, now: Date) {
  const { count } = await db.job.updateMany({
    where: { id: job.id, leaseOwner: job.workerId, attempts: job.attempts, status: "RUNNING" },
    data: { leaseExpiresAt: new Date(now.getTime() + leaseMs) },
  });
  if (count !== 1) throw new LeaseLostError();
}

export async function finishJob(tx: Client, job: ClaimedJob, status: "SUCCEEDED" | "FAILED", now: Date, lastError?: string) {
  const { count } = await tx.job.updateMany({
    where: { id: job.id, leaseOwner: job.workerId, attempts: job.attempts, status: "RUNNING" },
    data: { status, finishedAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: lastError?.slice(0, 500) ?? null },
  });
  if (count !== 1) throw new LeaseLostError();
}

export async function requeueJob(tx: Client, job: ClaimedJob, args: { now: Date; delayMs: number; error: string }) {
  const { count } = await tx.job.updateMany({
    where: { id: job.id, leaseOwner: job.workerId, attempts: job.attempts, status: "RUNNING" },
    data: { status: "QUEUED", runAfter: new Date(args.now.getTime() + args.delayMs), leaseOwner: null, leaseExpiresAt: null, lastError: args.error.slice(0, 500) },
  });
  if (count !== 1) throw new LeaseLostError();
}
