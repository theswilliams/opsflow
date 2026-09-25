export type WorkflowErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "VALIDATION_FAILED"
  | "APPROVAL_REQUIRED"
  | "NO_CHANGES"
  | "BAD_INPUT";

/** Domain error carrying a message that is safe to show to end users. */
export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    readonly userMessage: string,
  ) {
    super(`${code}: ${userMessage}`);
    this.name = "WorkflowError";
  }
}
