// Guards the database safeguards that Prisma cannot fully express (triggers, CHECK constraints) and that a
// generated migration could silently drop. Used by scripts/check-migrations.mjs (CI) and by tests.

/** Every safeguard the application relies on. Dropping any of these requires editing this list on purpose. */
export const PROTECTED = [
  // Uniqueness that backs approval / outbox / replay / queue invariants
  "Review_workflowId_key",
  "WorkflowAction_workflowId_type_key",
  "WorkflowAction_idempotencyKey_key",
  "Job_workflowId_type_key",
  "WebhookReceipt_userId_signatureHash_key",
  "Workflow_id_userId_key",
  "Workflow_userId_idempotencyKey_key",
  // Audit log guard
  "AuditEvent_guard_row",
  "AuditEvent_guard_truncate",
  "audit_event_guard",
  // CHECK constraints
  "User_email_lowercase",
  "WorkflowInput_size_nonneg",
  "ExtractedData_attempts_positive",
  "Workflow_idempotency_len",
  "Workflow_version_positive",
  "Job_attempts_nonneg",
  // Tenant-consistency and audit-retention foreign keys
  "AuditEvent_userId_fkey",
  "AuditEvent_workflowId_userId_fkey",
  "Job_workflowId_userId_fkey",
  "WorkflowAction_workflowId_userId_fkey",
  "Review_workflowId_userId_fkey",
];

const stripComments = (sql) => sql.replace(/--.*$/gm, "");

/** Returns the protected objects that a migration's SQL drops (and does not re-create in the same file). */
export function findDroppedSafeguards(sql) {
  const text = stripComments(sql);
  const dropped = [];
  for (const name of PROTECTED) {
    const q = String.raw`"?${name}"?(?![\w])`;
    const drops = new RegExp(String.raw`DROP\s+(?:INDEX|TRIGGER|FUNCTION|CONSTRAINT)\s+(?:IF\s+EXISTS\s+)?${q}`, "i");
    const recreates = new RegExp(String.raw`(?:CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRIGGER|FUNCTION)|ADD\s+CONSTRAINT)\s+${q}`, "i");
    if (drops.test(text) && !recreates.test(text)) dropped.push(name);
  }
  return dropped;
}
