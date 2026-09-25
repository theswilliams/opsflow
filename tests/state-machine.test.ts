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
    expect(canTransition("FAILED", "RECEIVED")).toBe(true); // retry processing
    expect(canTransition("FAILED", "APPROVED")).toBe(true); // retry the action (only reachable when approved)
    expect(canTransition("FAILED", "EXECUTING")).toBe(false); // must go back through APPROVED and the job queue
    expect(canTransition("FAILED", "COMPLETED")).toBe(false);
  });

  it("allows requeueing after a lost lease, but never skipping review", () => {
    for (const s of ["PROCESSING", "EXTRACTED", "VALIDATING"] as const) expect(canTransition(s, "RECEIVED")).toBe(true);
    expect(canTransition("EXECUTING", "APPROVED")).toBe(true);
    expect(canTransition("REVIEW_REQUIRED", "RECEIVED")).toBe(false);
    expect(canTransition("APPROVED", "RECEIVED")).toBe(false);
    expect(canTransition("COMPLETED", "APPROVED")).toBe(false);
  });

  it("never transitions a state to itself", () => {
    for (const s of WORKFLOW_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("throws a descriptive error on invalid transitions", () => {
    expect(() => assertTransition("PROCESSING", "APPROVED")).toThrow(/PROCESSING → APPROVED/);
  });
});
