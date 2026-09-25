import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { AUDIT, recordAudit, withAuditMaintenance } from "@/lib/workflow/audit";

/**
 * Data-subject controls: export, deletion and retention. These are engineering controls, not legal advice —
 * see docs/DATA.md for what is stored, why, for how long, and what is deliberately retained.
 */

/** Everything OpsFlow holds about a user, as plain JSON. Secrets (password hash, webhook secrets) are never included. */
export async function exportUserData(db: Db, userId: string, now = new Date()) {
  const [user, workflows, credentials, usage, notifications, audit] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, name: true, createdAt: true } }),
    db.workflow.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: {
        input: { omit: { rawBytes: true } },
        extracted: true,
        validations: true,
        reviews: true,
        actions: true,
      },
    }),
    db.apiCredential.findMany({ where: { userId }, select: { keyId: true, label: true, createdAt: true, revokedAt: true, lastUsedAt: true } }),
    db.aiUsage.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    db.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    db.auditEvent.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);
  await recordAudit(db, { userId, actor: { type: "USER", id: userId }, eventType: AUDIT.DATA_EXPORTED, message: "Account data exported", metadata: { workflows: workflows.length } });
  return { exportedAt: now.toISOString(), format: "opsflow-export-v1", user, workflows, credentials, aiUsage: usage, notifications, auditEvents: audit };
}

/**
 * Deletes an account by anonymising it. The user row is kept as a tombstone (so foreign keys and the
 * retained audit history stay intact) but everything personal is removed or scrubbed:
 *  - login and API credentials are destroyed, sessions revoked, in-flight jobs cancelled;
 *  - documents, extracted data, approved snapshots, confirmations and comments are erased;
 *  - audit events are RETAINED (that is their purpose) but their metadata is redacted.
 */
export async function deleteAccount(db: Db, userId: string, now = new Date()) {
  await withAuditMaintenance(db, async (tx) => {
    await tx.job.updateMany({ where: { userId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", lastError: "account deleted", leaseOwner: null, leaseExpiresAt: null, finishedAt: now } });
    await tx.workflow.updateMany({
      where: { userId, status: { notIn: ["COMPLETED", "REJECTED", "FAILED"] } },
      data: { status: "FAILED", failureReason: "Account deleted", needsAttention: false, attentionReason: null },
    });
    await tx.session.deleteMany({ where: { userId } });
    await tx.apiCredential.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.workflowInput.updateMany({ where: { userId }, data: { content: "[deleted]", rawBytes: null, fileName: null, purgedAt: now } });
    await tx.extractedData.deleteMany({ where: { userId } });
    await tx.validationResult.deleteMany({ where: { userId } });
    await tx.review.updateMany({ where: { userId }, data: { comment: null, approvedFields: Prisma.DbNull, changes: [] } });
    await tx.workflowAction.updateMany({ where: { userId }, data: { output: Prisma.DbNull, error: null } });
    await tx.workflow.updateMany({ where: { userId }, data: { customerName: null, customerKey: null, addressKey: null, deliveryDate: null } });
    await tx.auditEvent.updateMany({ where: { userId }, data: { metadata: { redacted: true } } });
    await tx.user.update({
      where: { id: userId },
      data: { email: `deleted-${userId}@deleted.invalid`, name: "Deleted user", passwordHash: "!", deletedAt: now },
    });
    await recordAudit(tx, { userId, actor: { type: "SYSTEM" }, eventType: AUDIT.ACCOUNT_DELETED, message: "Account deleted and personal data erased" });
  });
}

/**
 * Retention: once a workflow has been finished (completed, rejected or failed) for `retentionDays`, the raw
 * document and the extracted personal data are erased. The workflow shell, its status history and the audit
 * trail remain. `retentionDays = 0` disables purging.
 */
export async function purgeExpiredContent(db: Db, args: { retentionDays: number; now: Date; limit?: number }) {
  if (args.retentionDays <= 0) return { purged: 0 };
  const cutoff = new Date(args.now.getTime() - args.retentionDays * 86_400_000);
  const due = await db.workflow.findMany({
    where: { status: { in: ["COMPLETED", "REJECTED", "FAILED"] }, updatedAt: { lt: cutoff }, input: { is: { purgedAt: null } } },
    select: { id: true, userId: true },
    take: args.limit ?? 200,
  });
  for (const w of due) {
    await db.$transaction(async (tx) => {
      await tx.workflowInput.update({ where: { workflowId: w.id }, data: { content: "[purged]", rawBytes: null, purgedAt: args.now } });
      await tx.extractedData.deleteMany({ where: { workflowId: w.id } });
      await tx.review.updateMany({ where: { workflowId: w.id }, data: { approvedFields: Prisma.DbNull, changes: [] } });
      await tx.workflowAction.updateMany({ where: { workflowId: w.id }, data: { output: Prisma.DbNull } });
      await tx.workflow.update({ where: { id: w.id }, data: { customerName: null, customerKey: null, addressKey: null, deliveryDate: null } });
      await recordAudit(tx, { userId: w.userId, workflowId: w.id, actor: { type: "SYSTEM" }, eventType: AUDIT.CONTENT_PURGED, message: `Document and extracted data purged after ${args.retentionDays} days` });
    });
  }
  return { purged: due.length };
}
