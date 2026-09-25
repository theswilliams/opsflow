/**
 * Workflow lifecycle. Deliberately small: a lookup table, not an engine.
 *
 *  RECEIVED → PROCESSING → EXTRACTED → VALIDATING → REVIEW_REQUIRED → APPROVED → EXECUTING → COMPLETED
 *                 │             │           │              │  ▲            │          │
 *                 └─────────────┴───────────┴── FAILED ◄────┘  └ VALIDATING (after a human edit)
 *                                                 │       └→ REJECTED (terminal)
 *                                                 └→ PROCESSING (retry extraction) / EXECUTING (retry action, only if approved)
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
  PROCESSING: ["EXTRACTED", "FAILED"],
  EXTRACTED: ["VALIDATING", "FAILED"],
  VALIDATING: ["REVIEW_REQUIRED", "FAILED"],
  REVIEW_REQUIRED: ["VALIDATING", "APPROVED", "REJECTED", "FAILED"],
  APPROVED: ["EXECUTING", "FAILED"],
  EXECUTING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["PROCESSING", "EXECUTING"],
  REJECTED: [],
};

export const TERMINAL_STATUSES: readonly WorkflowStatusName[] = ["COMPLETED", "REJECTED"];

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

/** Statuses a person can still act on or that may still change. */
export const isOpen = (s: WorkflowStatusName) => !TERMINAL_STATUSES.includes(s);
