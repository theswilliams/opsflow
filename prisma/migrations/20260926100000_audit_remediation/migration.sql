-- Audit remediation: durable jobs, action outbox, webhook receipts, AI usage, optimistic versions,
-- duplicate-detection keys, retention columns and a stronger audit-log guard.
--
-- Everything expressible in schema.prisma is generated from it. The only hand-written statements are the
-- audit-log triggers and CHECK constraints at the bottom; tests/db-integrity.test.ts asserts they exist.

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('PROCESS_WORKFLOW', 'EXECUTE_ACTION');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterEnum (new values are not used inside this migration)
ALTER TYPE "ActionStatus" ADD VALUE 'PENDING';
ALTER TYPE "ActionStatus" ADD VALUE 'EXECUTING';

-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_userId_fkey";
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_workflowId_userId_fkey";

-- DropIndex
DROP INDEX "Review_workflowId_idx";
DROP INDEX "WorkflowAction_workflowId_idx";
-- The old PARTIAL unique index is replaced by a real, schema-declared UNIQUE (workflowId, type).
DROP INDEX "WorkflowAction_one_success_per_workflow";

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "approvedFields" JSONB, ADD COLUMN "approvedVersion" INTEGER;
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Workflow"
  ADD COLUMN "addressKey" TEXT,
  ADD COLUMN "customerKey" TEXT,
  ADD COLUMN "deliveryDate" TEXT,
  ADD COLUMN "reviewRequiredAt" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "WorkflowInput" ADD COLUMN "purgedAt" TIMESTAMP(3), ADD COLUMN "rawBytes" BYTEA;

-- WorkflowAction: one row per workflow+type. Collapse any legacy multi-row history first (keep the
-- SUCCEEDED row, else the newest), then backfill the new NOT NULL columns.
DELETE FROM "WorkflowAction" a
USING "WorkflowAction" b
WHERE a."workflowId" = b."workflowId" AND a."type" = b."type" AND a."id" <> b."id"
  AND (
    (b."status"::text = 'SUCCEEDED' AND a."status"::text <> 'SUCCEEDED')
    OR (b."status"::text = a."status"::text AND (b."createdAt", b."id") > (a."createdAt", a."id"))
  );
ALTER TABLE "WorkflowAction"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "WorkflowAction" SET "idempotencyKey" = 'legacy-' || "id", "updatedAt" = "createdAt", "attempts" = 1;
ALTER TABLE "WorkflowAction" ALTER COLUMN "idempotencyKey" SET NOT NULL, ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "WorkflowAction" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "signatureHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "workflowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costMicroUsd" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderDelivery" (
    "idempotencyKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderDelivery_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateIndex
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");
CREATE INDEX "Job_status_leaseExpiresAt_idx" ON "Job"("status", "leaseExpiresAt");
CREATE UNIQUE INDEX "Job_workflowId_type_key" ON "Job"("workflowId", "type");
CREATE INDEX "WebhookReceipt_userId_contentHash_createdAt_idx" ON "WebhookReceipt"("userId", "contentHash", "createdAt");
CREATE UNIQUE INDEX "WebhookReceipt_userId_signatureHash_key" ON "WebhookReceipt"("userId", "signatureHash");
CREATE INDEX "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
CREATE INDEX "Workflow_userId_customerKey_deliveryDate_idx" ON "Workflow"("userId", "customerKey", "deliveryDate");
CREATE INDEX "Workflow_status_updatedAt_idx" ON "Workflow"("status", "updatedAt");
CREATE UNIQUE INDEX "WorkflowAction_idempotencyKey_key" ON "WorkflowAction"("idempotencyKey");
CREATE UNIQUE INDEX "WorkflowAction_workflowId_type_key" ON "WorkflowAction"("workflowId", "type");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Review.workflowId is now declared @unique in schema.prisma; the hand-written index becomes the schema-owned one.
ALTER INDEX "Review_one_decision_per_workflow" RENAME TO "Review_workflowId_key";

-- ---------------------------------------------------------------------------
-- Hand-written (Prisma cannot express triggers or CHECK constraints)
-- ---------------------------------------------------------------------------

-- Audit log guard: UPDATE, DELETE and TRUNCATE are refused unless the transaction has explicitly entered
-- audit-maintenance mode (only the documented retention/erasure and demo-reset code paths do). This is an
-- application-level guarantee: a database OWNER/superuser can still drop the trigger.
CREATE OR REPLACE FUNCTION "audit_event_guard"() RETURNS trigger AS $$
BEGIN
  IF current_setting('opsflow.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditEvent rows are append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "AuditEvent_no_update" ON "AuditEvent";
DROP FUNCTION "audit_event_append_only"();

CREATE TRIGGER "AuditEvent_guard_row"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "audit_event_guard"();

CREATE TRIGGER "AuditEvent_guard_truncate"
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_event_guard"();

ALTER TABLE "Job" ADD CONSTRAINT "Job_attempts_nonneg" CHECK ("attempts" >= 0 AND "maxAttempts" >= 1);
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_version_positive" CHECK ("version" >= 1);
