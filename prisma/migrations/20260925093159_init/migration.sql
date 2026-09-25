-- CreateEnum
CREATE TYPE "WorkflowType" AS ENUM ('DELIVERY_REQUEST');

-- CreateEnum
CREATE TYPE "WorkflowSource" AS ENUM ('PASTE', 'UPLOAD', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CUSTOMER_CONFIRMATION');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'WEBHOOK');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "WorkflowType" NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'RECEIVED',
    "source" "WorkflowSource" NOT NULL,
    "customerName" TEXT,
    "overallConfidence" "ConfidenceLevel" NOT NULL DEFAULT 'UNKNOWN',
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowInput" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedData" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "aiOutput" JSONB NOT NULL,
    "fields" JSONB NOT NULL,
    "fieldStatus" JSONB NOT NULL,
    "missingInformation" JSONB NOT NULL,
    "ambiguities" JSONB NOT NULL,
    "requiresHumanReview" BOOLEAN NOT NULL,
    "reason" TEXT,
    "recommendedAction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractedData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationResult" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "errorCount" INTEGER NOT NULL,
    "warningCount" INTEGER NOT NULL,
    "issues" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "comment" TEXT,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAction" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ActionType" NOT NULL,
    "status" "ActionStatus" NOT NULL,
    "mode" TEXT NOT NULL,
    "executedBy" TEXT NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT,
    "userId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_keyId_key" ON "ApiCredential"("keyId");

-- CreateIndex
CREATE INDEX "ApiCredential_userId_idx" ON "ApiCredential"("userId");

-- CreateIndex
CREATE INDEX "Workflow_userId_status_idx" ON "Workflow"("userId", "status");

-- CreateIndex
CREATE INDEX "Workflow_userId_createdAt_idx" ON "Workflow"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_id_userId_key" ON "Workflow"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_userId_idempotencyKey_key" ON "Workflow"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInput_workflowId_key" ON "WorkflowInput"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInput_workflowId_userId_key" ON "WorkflowInput"("workflowId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedData_workflowId_key" ON "ExtractedData"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedData_workflowId_userId_key" ON "ExtractedData"("workflowId", "userId");

-- CreateIndex
CREATE INDEX "ValidationResult_workflowId_createdAt_idx" ON "ValidationResult"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "Review_workflowId_idx" ON "Review"("workflowId");

-- CreateIndex
CREATE INDEX "WorkflowAction_workflowId_idx" ON "WorkflowAction"("workflowId");

-- CreateIndex
CREATE INDEX "AuditEvent_workflowId_createdAt_idx" ON "AuditEvent"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_userId_createdAt_idx" ON "AuditEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInput" ADD CONSTRAINT "WorkflowInput_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedData" ADD CONSTRAINT "ExtractedData_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationResult" ADD CONSTRAINT "ValidationResult_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAction" ADD CONSTRAINT "WorkflowAction_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workflowId_userId_fkey" FOREIGN KEY ("workflowId", "userId") REFERENCES "Workflow"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

-- At most one SUCCEEDED action per workflow and type: a second concurrent
-- execution of the same approved workflow is rejected by the database itself.
CREATE UNIQUE INDEX "WorkflowAction_one_success_per_workflow"
  ON "WorkflowAction" ("workflowId", "type")
  WHERE "status" = 'SUCCEEDED';

-- A workflow has at most one review decision of each kind that is final.
CREATE UNIQUE INDEX "Review_one_decision_per_workflow"
  ON "Review" ("workflowId");

-- Defence in depth for sizes and formats.
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "WorkflowInput" ADD CONSTRAINT "WorkflowInput_size_nonneg" CHECK ("sizeBytes" >= 0);
ALTER TABLE "ExtractedData" ADD CONSTRAINT "ExtractedData_attempts_positive" CHECK ("attempts" >= 1);
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_idempotency_len" CHECK ("idempotencyKey" IS NULL OR char_length("idempotencyKey") BETWEEN 1 AND 200);
