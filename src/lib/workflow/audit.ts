import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

export type Actor = { type: "USER"; id: string } | { type: "SYSTEM" } | { type: "WEBHOOK"; id: string };

export const AUDIT = {
  RECEIVED: "WORKFLOW_RECEIVED",
  EXTRACTION_COMPLETED: "EXTRACTION_COMPLETED",
  EXTRACTION_FAILED: "EXTRACTION_FAILED",
  VALIDATION_COMPLETED: "VALIDATION_COMPLETED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  FIELDS_EDITED: "FIELDS_EDITED",
  APPROVED: "WORKFLOW_APPROVED",
  REJECTED: "WORKFLOW_REJECTED",
  ACTION_EXECUTED: "ACTION_EXECUTED",
  ACTION_FAILED: "ACTION_FAILED",
  COMPLETED: "WORKFLOW_COMPLETED",
  FAILED: "WORKFLOW_FAILED",
  RETRY_REQUESTED: "RETRY_REQUESTED",
  PROCESSING_RETRY: "PROCESSING_RETRY",
  DATA_EXPORTED: "DATA_EXPORTED",
  ACCOUNT_DELETED: "ACCOUNT_DELETED",
  CONTENT_PURGED: "CONTENT_PURGED",
  WEBHOOK_REJECTED: "WEBHOOK_REJECTED",
  CREDENTIAL_CREATED: "CREDENTIAL_CREATED",
  CREDENTIAL_REVOKED: "CREDENTIAL_REVOKED",
} as const;

type Client = Db | Prisma.TransactionClient;

export interface AuditInput {
  userId: string;
  workflowId?: string | null;
  actor: Actor;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Appends an audit event. Metadata must be small and must not contain raw document text. */
export async function recordAudit(client: Client, e: AuditInput) {
  return client.auditEvent.create({
    data: {
      userId: e.userId,
      workflowId: e.workflowId ?? null,
      actorType: e.actor.type,
      actorId: "id" in e.actor ? e.actor.id : null,
      eventType: e.eventType,
      message: e.message,
      metadata: (e.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Phone numbers are masked in audit metadata; everything else is business data needed for accountability. */
export function auditValue(field: string, value: unknown): unknown {
  if (field === "contact_phone" && typeof value === "string") return `***${value.replace(/\D/g, "").slice(-2)}`;
  return value;
}

/**
 * The ONLY sanctioned way to modify or delete audit rows (retention purge, account erasure, demo reset).
 * The database trigger refuses any UPDATE/DELETE/TRUNCATE on AuditEvent unless the current transaction has
 * set `opsflow.audit_maintenance = on`; `set_config(..., true)` scopes it to this transaction only.
 * Refuses to run in production unless explicitly allowed by the caller.
 */
export async function withAuditMaintenance<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('opsflow.audit_maintenance', 'on', true)`;
    return fn(tx);
  });
}
