/**
 * Workflow lifecycle. Deliberately small: a lookup table, not an engine.
 *
 *  RECEIVED → PROCESSING → EXTRACTED → VALIDATING → REVIEW_REQUIRED → APPROVED → EXECUTING → COMPLETED
 *                 │             │           │              │  ▲            │          │
 *                 └─────────────┴───────────┴── FAILED ◄────┘  └ VALIDATING (after a human edit)
 *                                                 │       └→ REJECTED (terminal)
 *                                                 └→ RECEIVED (retry processing) / APPROVED (retry action, only if approved)
 */
export const WORKFLOW_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "EXTRACTED",
  "VALIDATING",
  "REVIEW_REQUIRED",
  "APPROVED",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
  "REJECTED",
] as const;
export type WorkflowStatusName = (typeof WORKFLOW_STATUSES)[number];

const TRANSITIONS: Record<WorkflowStatusName, readonly WorkflowStatusName[]> = {
  RECEIVED: ["PROCESSING", "FAILED"],
  // PROCESSING/EXTRACTED/VALIDATING → RECEIVED is "requeue": a worker died or a transient error occurred.
  PROCESSING: ["EXTRACTED", "FAILED", "RECEIVED"],
  EXTRACTED: ["VALIDATING", "FAILED", "RECEIVED"],
  VALIDATING: ["REVIEW_REQUIRED", "FAILED", "RECEIVED"],
  REVIEW_REQUIRED: ["VALIDATING", "APPROVED", "REJECTED", "FAILED"],
  APPROVED: ["EXECUTING", "FAILED"],
  // EXECUTING → APPROVED is "requeue" after a lost lease; the action's idempotency key prevents a second send.
  EXECUTING: ["COMPLETED", "FAILED", "APPROVED"],
  COMPLETED: [],
  // Retry: re-process from scratch, or (only if a human approved it) re-run the action.
  FAILED: ["RECEIVED", "APPROVED"],
  REJECTED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: WorkflowStatusName,
    readonly to: WorkflowStatusName,
  ) {
    super(`Invalid workflow transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export const canTransition = (from: WorkflowStatusName, to: WorkflowStatusName) => TRANSITIONS[from].includes(to);

export function assertTransition(from: WorkflowStatusName, to: WorkflowStatusName): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const nextStatuses = (from: WorkflowStatusName) => TRANSITIONS[from];

/** Validates a multi-step path (used when several transitions are committed atomically in one transaction). */
export function assertPath(...path: WorkflowStatusName[]): void {
  for (let i = 0; i < path.length - 1; i++) assertTransition(path[i]!, path[i + 1]!);
}
