import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, InvalidTransitionError, nextStatuses, WORKFLOW_STATUSES } from "@/lib/workflow/state-machine";

describe("workflow state machine", () => {
  it("allows the happy path", () => {
    const path = ["RECEIVED", "PROCESSING", "EXTRACTED", "VALIDATING", "REVIEW_REQUIRED", "APPROVED", "EXECUTING", "COMPLETED"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it("cannot skip review: no path from extraction straight to execution", () => {
    expect(canTransition("EXTRACTED", "EXECUTING")).toBe(false);
    expect(canTransition("VALIDATING", "APPROVED")).toBe(false);
    expect(canTransition("REVIEW_REQUIRED", "EXECUTING")).toBe(false);
    expect(canTransition("REVIEW_REQUIRED", "COMPLETED")).toBe(false);
    expect(canTransition("RECEIVED", "APPROVED")).toBe(false);
  });

  it("allows a re-validation loop after a human edit", () => {
    expect(canTransition("REVIEW_REQUIRED", "VALIDATING")).toBe(true);
  });

  it("treats REJECTED and COMPLETED as terminal", () => {
    expect(nextStatuses("REJECTED")).toEqual([]);
    expect(nextStatuses("COMPLETED")).toEqual([]);
    expect(() => assertTransition("REJECTED", "APPROVED")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("COMPLETED", "EXECUTING")).toThrow(InvalidTransitionError);
  });

  it("supports failure from any in-flight state and retry from FAILED", () => {
    for (const s of ["RECEIVED", "PROCESSING", "EXTRACTED", "VALIDATING", "REVIEW_REQUIRED", "APPROVED", "EXECUTING"] as const) {
      expect(canTransition(s, "FAILED")).toBe(true);
    }
    expect(canTransition("FAILED", "PROCESSING")).toBe(true);
    expect(canTransition("FAILED", "EXECUTING")).toBe(true);
    expect(canTransition("FAILED", "COMPLETED")).toBe(false);
  });

  it("never transitions a state to itself", () => {
    for (const s of WORKFLOW_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("throws a descriptive error on invalid transitions", () => {
    expect(() => assertTransition("PROCESSING", "APPROVED")).toThrow(/PROCESSING → APPROVED/);
  });
});
