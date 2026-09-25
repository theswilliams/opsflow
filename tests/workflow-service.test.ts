import { describe, expect, it } from "vitest";
import { extractDeliveryRequest, MockAIProvider } from "@/lib/ai/mock-provider";
import { getDb } from "@/lib/db";
import { WorkflowError } from "@/lib/workflow/errors";
import {
  approveWorkflow,
  createWorkflow,
  editWorkflowFields,
  executeApprovedWorkflow,
  processWorkflow,
  rejectWorkflow,
  retryWorkflow,
} from "@/lib/workflow/service";
import { DELIVERY_TEXT, FailingActionProvider, makeUser, makeWorkflow, ScriptedProvider, TODAY, testDeps } from "./helpers";

const db = getDb();
const actorFor = (userId: string) => ({ type: "USER", id: userId }) as const;

describe("processing", () => {
  it("takes a request from RECEIVED to REVIEW_REQUIRED with data, validation and audit trail", async () => {
    const user = await makeUser();
    const { id, workflow } = await makeWorkflow(user.id);
    expect(workflow.status).toBe("REVIEW_REQUIRED");
    expect(workflow.customerName).toBe("ABC Building Supplies");
    expect(workflow.needsAttention).toBe(true);
    expect(workflow.overallConfidence).toBe("MEDIUM");

    const extracted = await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } });
    expect(extracted.provider).toBe("mock");
    const validation = await db.validationResult.findFirstOrThrow({ where: { workflowId: id } });
    expect(validation.passed).toBe(true);
    expect(validation.warningCount).toBeGreaterThan(0);

    const events = (await db.auditEvent.findMany({ where: { workflowId: id }, orderBy: { createdAt: "asc" } })).map((e) => e.eventType);
    expect(events).toEqual(["WORKFLOW_RECEIVED", "EXTRACTION_COMPLETED", "VALIDATION_COMPLETED", "REVIEW_REQUIRED"]);
  });

  it("never stores raw document text in audit metadata", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const events = await db.auditEvent.findMany({ where: { workflowId: id } });
    expect(JSON.stringify(events)).not.toContain("roofing shingles");
    expect(JSON.stringify(events)).not.toContain("125 King");
  });

  it("marks the workflow FAILED (not stuck) when the AI returns garbage, then recovers on retry", async () => {
    const user = await makeUser();
    const bad = testDeps({ ai: new ScriptedProvider([() => ({ output: { nope: true }, model: "m" })]) });
    const { id, workflow } = await makeWorkflow(user.id, DELIVERY_TEXT, bad);
    expect(workflow.status).toBe("FAILED");
    expect(workflow.failureReason).toMatch(/structure/);
    expect(await db.auditEvent.findFirst({ where: { workflowId: id, eventType: "EXTRACTION_FAILED" } })).not.toBeNull();

    const retried = await retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) });
    expect(retried.status).toBe("REVIEW_REQUIRED");
    expect(retried.failureReason).toBeNull();
  });

  it("cannot process a workflow twice", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await expect(processWorkflow(testDeps(), { workflowId: id, userId: user.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("is idempotent on (user, key) and detects key reuse with different content", async () => {
    const user = await makeUser();
    const deps = testDeps();
    const args = { userId: user.id, actor: actorFor(user.id), source: "WEBHOOK", kind: "text", text: DELIVERY_TEXT, idempotencyKey: "k-1" } as const;
    const a = await createWorkflow(deps, args);
    const b = await createWorkflow(deps, args);
    const c = await createWorkflow(deps, { ...args, text: `${DELIVERY_TEXT} extra` });
    expect(b).toMatchObject({ id: a.id, duplicate: true, conflict: false });
    expect(c).toMatchObject({ id: a.id, duplicate: true, conflict: true });
    expect(await db.workflow.count({ where: { userId: user.id } })).toBe(1);
  });

  it("the same idempotency key under a different user is independent", async () => {
    const [u1, u2] = [await makeUser(), await makeUser()];
    const deps = testDeps();
    const mk = (userId: string) => createWorkflow(deps, { userId, actor: actorFor(userId), source: "WEBHOOK", kind: "text", text: DELIVERY_TEXT, idempotencyKey: "shared" });
    expect((await mk(u1.id)).id).not.toBe((await mk(u2.id)).id);
  });

  it("flags a suspected duplicate request", async () => {
    const user = await makeUser();
    await makeWorkflow(user.id);
    const second = await makeWorkflow(user.id);
    const v = await db.validationResult.findFirstOrThrow({ where: { workflowId: second.id } });
    expect((v.issues as { code: string }[]).map((i) => i.code)).toContain("DUPLICATE_SUSPECTED");
  });
});

describe("human approval boundary", () => {
  it("cannot execute an unapproved workflow", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await expect(executeApprovedWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(await db.workflowAction.count({ where: { workflowId: id } })).toBe(0);
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("REVIEW_REQUIRED");
  });

  it("cannot execute even if status is forged to APPROVED without a recorded review", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await db.workflow.update({ where: { id }, data: { status: "APPROVED" } });
    await expect(executeApprovedWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("approval executes the action and completes the workflow", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const done = await approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) });
    expect(done.status).toBe("COMPLETED");
    const action = await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } });
    expect(action).toMatchObject({ status: "SUCCEEDED", mode: "simulated", executedBy: user.id });
    const output = action.output as { body: string; delivery: string };
    expect(output.body).toContain("Delivery request approved.");
    expect(output.body).toContain("ABC Building Supplies");
    expect(output.body).toContain("4 pallets of roofing shingles");
    expect(output.delivery).toMatch(/SIMULATED/);
    const events = (await db.auditEvent.findMany({ where: { workflowId: id }, orderBy: { createdAt: "asc" } })).map((e) => e.eventType);
    expect(events.slice(-3)).toEqual(["WORKFLOW_APPROVED", "ACTION_EXECUTED", "WORKFLOW_COMPLETED"]);
    expect(await db.review.findFirstOrThrow({ where: { workflowId: id } })).toMatchObject({ decision: "APPROVED", reviewerId: user.id });
  });

  it("refuses approval while validation errors exist and changes nothing", async () => {
    const user = await makeUser();
    const { id, workflow } = await makeWorkflow(user.id, "Customer: Acme\n5 pallets of tile tomorrow morning");
    expect(workflow.status).toBe("REVIEW_REQUIRED");
    await expect(approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("REVIEW_REQUIRED");
    expect(await db.review.count({ where: { workflowId: id } })).toBe(0);
  });

  it("rejecting is terminal: no approve, edit or execute afterwards", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await rejectWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id), comment: "Duplicate order" });
    expect(await db.workflow.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "REJECTED" });
    expect(await db.review.findFirstOrThrow({ where: { workflowId: id } })).toMatchObject({ decision: "REJECTED", comment: "Duplicate order" });
    const args = { workflowId: id, userId: user.id, actor: actorFor(user.id) };
    await expect(approveWorkflow(testDeps(), args)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(rejectWorkflow(testDeps(), args)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(editWorkflowFields(testDeps(), { ...args, updates: { customer: "X" } })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(executeApprovedWorkflow(testDeps(), args)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("two simultaneous approvals produce exactly one execution", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const args = { workflowId: id, userId: user.id, actor: actorFor(user.id) };
    const results = await Promise.allSettled([approveWorkflow(testDeps(), args), approveWorkflow(testDeps(), args)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(WorkflowError);
    expect(await db.workflowAction.count({ where: { workflowId: id, status: "SUCCEEDED" } })).toBe(1);
    expect(await db.review.count({ where: { workflowId: id } })).toBe(1);
  });
});

describe("edits", () => {
  it("records every edit, preserves the original AI output, clears the resolved ambiguity", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const original = (await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } })).aiOutput;

    const { changes } = await editWorkflowFields(testDeps(), {
      workflowId: id,
      userId: user.id,
      actor: actorFor(user.id),
      updates: { requested_time_start: "09:00", requested_time_end: "11:00", contact_phone: "519-555-0142" },
    });
    expect(changes.map((c) => c.field).sort()).toEqual(["contact_phone", "requested_time_end", "requested_time_start", "requested_time_window"].sort());

    const after = await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } });
    expect(after.aiOutput).toEqual(original);
    expect(after.fields).toMatchObject({ requested_time_start: "09:00", requested_time_window: "specific", contact_phone: "519-555-0142" });
    expect(after.ambiguities).toEqual([]);
    expect((after.fieldStatus as Record<string, { edited?: boolean }>).requested_time_start?.edited).toBe(true);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { workflowId: id, eventType: "FIELDS_EDITED" } });
    expect(audit.actorId).toBe(user.id);
    const recorded = (audit.metadata as { changes: { field: string; from: unknown; to: unknown }[] }).changes;
    expect(recorded.find((c) => c.field === "requested_time_start")).toMatchObject({ from: null, to: "09:00" });
    expect(recorded.find((c) => c.field === "contact_phone")?.to).toBe("***42"); // phone masked in audit

    // Re-validated after the edit and returned to review with the time warning gone.
    const w = await db.workflow.findUniqueOrThrow({ where: { id } });
    expect(w.status).toBe("REVIEW_REQUIRED");
    const v = await db.validationResult.findFirstOrThrow({ where: { workflowId: id }, orderBy: { createdAt: "desc" } });
    expect((v.issues as { code: string }[]).map((i) => i.code)).not.toContain("TIME_NOT_SPECIFIC");
  });

  it("the approval review captures the difference from the AI output", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await editWorkflowFields(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id), updates: { requested_time_start: "09:00", requested_time_end: "11:00" } });
    await approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id), comment: "Confirmed by phone" });
    const review = await db.review.findFirstOrThrow({ where: { workflowId: id } });
    expect((review.changes as { field: string }[]).map((c) => c.field)).toContain("requested_time_start");
    expect(review.comment).toBe("Confirmed by phone");
    const output = (await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } })).output as { body: string };
    expect(output.body).toContain("9:00 AM – 11:00 AM");
  });

  it("a human can supply missing data and then approve", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id, "Customer: Acme\n5 pallets of tile tomorrow at 9am. Call Sam 519-555-0100");
    await expect(approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await editWorkflowFields(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id), updates: { address: "10 Main Street, Toronto, Ontario" } });
    const done = await approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) });
    expect(done.status).toBe("COMPLETED");
  });

  it("rejects invalid edits and no-op edits", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const args = { workflowId: id, userId: user.id, actor: actorFor(user.id) };
    await expect(editWorkflowFields(testDeps(), { ...args, updates: { requested_date: "Friday" } })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(editWorkflowFields(testDeps(), { ...args, updates: { webhook_url: "http://evil.test" } })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(editWorkflowFields(testDeps(), { ...args, updates: { customer: "ABC Building Supplies" } })).rejects.toMatchObject({ code: "NO_CHANGES" });
  });

  it("regression: values that merely round-trip through jsonb (key order) are not reported as edits", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const args = { workflowId: id, userId: user.id, actor: actorFor(user.id) };
    await expect(
      editWorkflowFields(testDeps(), { ...args, updates: { items: [{ unit: "pallets", quantity: 4, description: "roofing shingles" }], customer: "ABC Building Supplies" } }),
    ).rejects.toMatchObject({ code: "NO_CHANGES" });
  });

  it("regression: explicit times supersede a general window and resolve its ambiguity and contact concern", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    // The review form always posts the current window ("morning") alongside the new times.
    const { changes } = await editWorkflowFields(testDeps(), {
      workflowId: id,
      userId: user.id,
      actor: actorFor(user.id),
      updates: { requested_time_window: "morning", requested_time_start: "09:00", requested_time_end: "11:00", contact_phone: "519-555-0142" },
    });
    expect(changes.map((c) => c.field)).toContain("requested_time_window");
    const after = await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } });
    const status = after.fieldStatus as Record<string, { status: string; confidence: string }>;
    expect(after.fields).toMatchObject({ requested_time_window: "specific" });
    expect(status.requested_time_window).toMatchObject({ status: "known", confidence: "high" });
    expect(status.contact_name).toMatchObject({ confidence: "high" });
  });

  it("an edit that introduces an error blocks approval", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const args = { workflowId: id, userId: user.id, actor: actorFor(user.id) };
    await editWorkflowFields(testDeps(), { ...args, updates: { items: [{ description: "shingles", quantity: -4, unit: "pallets" }] } });
    await expect(approveWorkflow(testDeps(), args)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("failure handling", () => {
  it("records a failed action, surfaces FAILED, and a retry succeeds without double-executing", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const failing = testDeps({ actions: new FailingActionProvider() });
    const failed = await approveWorkflow(failing, { workflowId: id, userId: user.id, actor: actorFor(user.id) });
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toBe("The confirmation service is unavailable.");
    expect(await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } })).toMatchObject({ status: "FAILED", error: "The confirmation service is unavailable." });

    const retried = await retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) });
    expect(retried.status).toBe("COMPLETED");
    expect(await db.workflowAction.count({ where: { workflowId: id, status: "SUCCEEDED" } })).toBe(1);
    await expect(retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorFor(user.id) })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("does not leak internal error details into the workflow", async () => {
    const user = await makeUser();
    const boom = testDeps({ actions: { name: "x", mode: "simulated", execute: async () => Promise.reject(new Error("ECONNREFUSED 10.0.0.5:5432 password=hunter2")) } });
    const { id } = await makeWorkflow(user.id);
    const w = await approveWorkflow(boom, { workflowId: id, userId: user.id, actor: actorFor(user.id) });
    expect(w.status).toBe("FAILED");
    expect(JSON.stringify(w)).not.toMatch(/hunter2|ECONNREFUSED|10\.0\.0\.5/);
    expect(JSON.stringify(await db.auditEvent.findMany({ where: { workflowId: id } }))).not.toMatch(/hunter2|ECONNREFUSED/);
  });
});

describe("database constraints", () => {
  it("refuses a child row whose owner differs from its workflow's owner", async () => {
    const [owner, other] = [await makeUser(), await makeUser()];
    const { id } = await makeWorkflow(owner.id);
    await expect(
      db.workflowAction.create({ data: { workflowId: id, userId: other.id, type: "CUSTOMER_CONFIRMATION", status: "SUCCEEDED", mode: "simulated", executedBy: other.id } }),
    ).rejects.toThrow();
    await expect(db.auditEvent.create({ data: { workflowId: id, userId: other.id, actorType: "USER", eventType: "X", message: "x" } })).rejects.toThrow();
  });

  it("allows at most one SUCCEEDED action per workflow", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const data = { workflowId: id, userId: user.id, type: "CUSTOMER_CONFIRMATION", status: "SUCCEEDED", mode: "simulated", executedBy: user.id } as const;
    await db.workflowAction.create({ data });
    await expect(db.workflowAction.create({ data })).rejects.toThrow();
    await db.workflowAction.create({ data: { ...data, status: "FAILED" } }); // failures may repeat
  });

  it("enforces lowercase emails and idempotency key length in the database", async () => {
    await expect(db.user.create({ data: { email: "Mixed@Case.test", name: "x", passwordHash: "x" } })).rejects.toThrow();
    const user = await makeUser();
    await expect(db.workflow.create({ data: { userId: user.id, type: "DELIVERY_REQUEST", source: "WEBHOOK", idempotencyKey: "" } })).rejects.toThrow();
  });
});

describe("mock extraction stays consistent with stored data", () => {
  it("stores the exact validated AI output", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const stored = await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } });
    expect((stored.aiOutput as { fields: unknown }).fields).toEqual(extractDeliveryRequest(DELIVERY_TEXT, TODAY).fields);
    expect(new MockAIProvider().isMock).toBe(true);
  });
});
