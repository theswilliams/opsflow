import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowStatus } from "@/generated/prisma/enums";
import type { Db } from "@/lib/db";
import { WORKFLOW_STATUSES } from "./state-machine";

/**
 * Read models. EVERY query is scoped by `userId` in the WHERE clause — tenant isolation
 * is never left to the caller. A workflow that belongs to someone else is indistinguishable from one that does not exist.
 */

export const PAGE_SIZE = 10;

export interface ListFilters {
  status?: string;
  q?: string;
  page?: number;
}

export function parseStatusFilter(value: string | undefined): WorkflowStatus | undefined {
  return (WORKFLOW_STATUSES as readonly string[]).includes(value ?? "") ? (value as WorkflowStatus) : undefined;
}

export async function listWorkflows(db: Db, userId: string, filters: ListFilters) {
  const status = parseStatusFilter(filters.status);
  const q = filters.q?.trim().slice(0, 80);
  const where: Prisma.WorkflowWhereInput = {
    userId,
    ...(status ? { status } : {}),
    ...(q
      ? { OR: [{ customerName: { contains: q, mode: "insensitive" } }, { id: { endsWith: q.toLowerCase() } }] }
      : {}),
  };
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const [rows, total] = await Promise.all([
    db.workflow.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    db.workflow.count({ where }),
  ]);
  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

export async function dashboardStats(db: Db, userId: string) {
  const grouped = await db.workflow.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } });
  const count = (s: WorkflowStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  return {
    total: grouped.reduce((n, g) => n + g._count._all, 0),
    pendingReview: count("REVIEW_REQUIRED"),
    completed: count("COMPLETED"),
    failed: count("FAILED"),
  };
}

export function attentionRequired(db: Db, userId: string, take = 6) {
  return db.workflow.findMany({
    where: { userId, OR: [{ status: "REVIEW_REQUIRED", needsAttention: true }, { status: "FAILED" }] },
    orderBy: { updatedAt: "desc" },
    take,
  });
}

export function recentActivity(db: Db, userId: string, take = 8) {
  return db.auditEvent.findMany({
    where: { userId, workflowId: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    include: { workflow: { select: { id: true, customerName: true } } },
  });
}

export function getWorkflowDetail(db: Db, userId: string, id: string) {
  return db.workflow.findFirst({
    where: { id, userId },
    include: {
      input: true,
      extracted: true,
      validations: { orderBy: { createdAt: "desc" }, take: 1 },
      reviews: { orderBy: { createdAt: "asc" } },
      actions: { orderBy: { createdAt: "asc" } },
      jobs: { select: { type: true, status: true, attempts: true, maxAttempts: true, runAfter: true } },
      auditEvents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
}

export type WorkflowDetail = NonNullable<Awaited<ReturnType<typeof getWorkflowDetail>>>;

export function recentNotifications(db: Db, userId: string, take = 5) {
  return db.notification.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
}

/** AI usage rows for the last `days` days plus the most recent individual requests. */
export async function aiUsageOverview(db: Db, userId: string, now: Date, days = 14) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [rows, recent] = await Promise.all([
    db.aiUsage.findMany({ where: { userId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 5000 }),
    db.aiUsage.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, include: { workflow: { select: { id: true, customerName: true } } } }),
  ]);
  return { rows, recent };
}
