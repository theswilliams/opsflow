import { describe, expect, it } from "vitest";
import { extractDeliveryRequest } from "@/lib/ai/mock-provider";
import { getDb } from "@/lib/db";
import { drainJobs } from "@/lib/jobs/worker";
import { enqueueJob } from "@/lib/jobs/queue";
import { WorkflowError } from "@/lib/workflow/errors";
import { approveWorkflow, createWorkflow, editWorkflowFields, rejectWorkflow, retryWorkflow } from "@/lib/workflow/service";
import {
  actorOf,
  approveCurrent,
  CLEAN_TEXT,
  DELIVERY_TEXT,
  editCurrent,
  FailingActionProvider,
  makeUser,
  makeWorkflow,
  ScriptedProvider,
  TODAY,
  testDeps,
  versionOf,
} from "./helpers";

const db = getDb();
const eventsOf = async (workflowId: string) =>
  (await db.auditEvent.findMany({ where: { workflowId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((e) => e.eventType);

describe("processing", () => {
  it("takes a request from RECEIVED to REVIEW_REQUIRED with data, validation and audit trail", async () => {
    const user = await makeUser();
    const { id, workflow } = await makeWorkflow(user.id);
    expect(workflow.status).toBe("REVIEW_REQUIRED");
    expect(workflow.customerName).toBe("ABC Building Supplies");
    expect(workflow.needsAttention).toBe(true);
    expect(workflow.overallConfidence).toBe("MEDIUM");
    expect(workflow.reviewRequiredAt).not.toBeNull();

    const extracted = await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } });
    expect(extracted.provider).toBe("mock");
    const validation = await db.validationResult.findFirstOrThrow({ where: { workflowId: id } });
    expect(validation.passed).toBe(true);
    expect(validation.warningCount).toBeGreaterThan(0);
    expect(await eventsOf(id)).toEqual(["WORKFLOW_RECEIVED", "EXTRACTION_COMPLETED", "VALIDATION_COMPLETED", "REVIEW_REQUIRED"]);
    expect(await db.notification.count({ where: { workflowId: id, kind: "REVIEW_REQUIRED" } })).toBe(1);
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

    const retried = await retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id) });
    expect(retried.status).toBe("REVIEW_REQUIRED");
    expect(retried.failureReason).toBeNull();
  });

  it("is idempotent: a second processing job for an already-processed workflow is a no-op", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await enqueueJob(db, { userId: user.id, workflowId: id, type: "PROCESS_WORKFLOW", maxAttempts: 3 });
    await drainJobs(testDeps());
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("REVIEW_REQUIRED");
    expect(await db.extractedData.count({ where: { workflowId: id } })).toBe(1);
  });

  it("is idempotent on (user, key) and detects key reuse with different content", async () => {
    const user = await makeUser();
    const deps = testDeps();
    const args = { userId: user.id, actor: actorOf(user.id), source: "WEBHOOK", kind: "text", text: DELIVERY_TEXT, idempotencyKey: "k-1" } as const;
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
    const mk = (userId: string) => createWorkflow(deps, { userId, actor: actorOf(userId), source: "WEBHOOK", kind: "text", text: DELIVERY_TEXT, idempotencyKey: "shared" });
    expect((await mk(u1.id)).id).not.toBe((await mk(u2.id)).id);
  });

  it("creates the workflow and its job atomically (no workflow without a job)", async () => {
    const user = await makeUser();
    const { id } = await createWorkflow(testDeps(), { userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT });
    const job = await db.job.findUniqueOrThrow({ where: { workflowId_type: { workflowId: id, type: "PROCESS_WORKFLOW" } } });
    expect(job.status).toBe("QUEUED");
  });
});

describe("human approval boundary", () => {
  it("the executor refuses to run without a persisted approval, and changes nothing", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await enqueueJob(db, { userId: user.id, workflowId: id, type: "EXECUTE_ACTION", maxAttempts: 3 });
    await drainJobs(testDeps());
    expect(await db.workflowAction.count({ where: { workflowId: id } })).toBe(0);
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("REVIEW_REQUIRED");
    expect((await db.job.findUniqueOrThrow({ where: { workflowId_type: { workflowId: id, type: "EXECUTE_ACTION" } } })).status).toBe("FAILED");
  });

  it("cannot execute even if status is forged to APPROVED without a recorded review", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await db.workflow.update({ where: { id }, data: { status: "APPROVED" } });
    await enqueueJob(db, { userId: user.id, workflowId: id, type: "EXECUTE_ACTION", maxAttempts: 3 });
    await drainJobs(testDeps());
    expect(await db.workflowAction.count({ where: { workflowId: id } })).toBe(0);
    await expect(retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id) })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("approval executes the action and completes the workflow", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const done = await approveCurrent(testDeps(), id, user.id);
    expect(done.status).toBe("COMPLETED");
    const action = await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } });
    expect(action).toMatchObject({ status: "SUCCEEDED", mode: "simulated", executedBy: user.id });
    expect(action.idempotencyKey).toBe(`wf:${id}:customer_confirmation:v${done.version}`);
    const output = action.output as { body: string; delivery: string };
    expect(output.body).toContain("Delivery request approved.");
    expect(output.body).toContain("ABC Building Supplies");
    expect(output.body).toContain("4 pallets of roofing shingles");
    expect(output.delivery).toMatch(/SIMULATED/);
    expect((await eventsOf(id)).slice(-3)).toEqual(["WORKFLOW_APPROVED", "ACTION_EXECUTED", "WORKFLOW_COMPLETED"]);
    expect(await db.review.findFirstOrThrow({ where: { workflowId: id } })).toMatchObject({ decision: "APPROVED", reviewerId: user.id, approvedVersion: done.version });
  });

  it("refuses approval while validation errors exist and changes nothing", async () => {
    const user = await makeUser();
    const { id, workflow } = await makeWorkflow(user.id, "Customer: Acme\n5 pallets of tile tomorrow morning");
    expect(workflow.status).toBe("REVIEW_REQUIRED");
    await expect(approveCurrent(testDeps(), id, user.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("REVIEW_REQUIRED");
    expect(await db.review.count({ where: { workflowId: id } })).toBe(0);
  });

  it("rejecting is terminal: no approve, edit or retry afterwards", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await rejectWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), comment: "Duplicate order" });
    expect(await db.workflow.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "REJECTED" });
    expect(await db.review.findFirstOrThrow({ where: { workflowId: id } })).toMatchObject({ decision: "REJECTED", comment: "Duplicate order" });
    const args = { workflowId: id, userId: user.id, actor: actorOf(user.id) };
    await expect(approveWorkflow(testDeps(), { ...args, expectedVersion: 1 })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(rejectWorkflow(testDeps(), args)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(editWorkflowFields(testDeps(), { ...args, updates: { customer: "X" } })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(retryWorkflow(testDeps(), args)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("two simultaneous approvals produce exactly one execution", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const v = await versionOf(id);
    const args = { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: v };
    const results = await Promise.allSettled([approveWorkflow(testDeps(), args), approveWorkflow(testDeps(), args)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(WorkflowError);
    expect(await db.workflowAction.count({ where: { workflowId: id, status: "SUCCEEDED" } })).toBe(1);
    expect(await db.providerDelivery.count({ where: { idempotencyKey: { contains: id } } })).toBe(1);
    expect(await db.review.count({ where: { workflowId: id } })).toBe(1);
  });
});

describe("edits", () => {
  it("records every edit, preserves the original AI output, clears the resolved ambiguity, bumps the version", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const original = (await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } })).aiOutput;
    const v0 = await versionOf(id);

    const { changes, version } = await editCurrent(testDeps(), id, user.id, {
      requested_time_start: "09:00",
      requested_time_end: "11:00",
      contact_phone: "519-555-0142",
    });
    expect(changes.map((c) => c.field).sort()).toEqual(["contact_phone", "requested_time_end", "requested_time_start", "requested_time_window"].sort());
    expect(version).toBe(v0 + 1);

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

    const w = await db.workflow.findUniqueOrThrow({ where: { id } });
    expect(w.status).toBe("REVIEW_REQUIRED");
    const v = await db.validationResult.findFirstOrThrow({ where: { workflowId: id }, orderBy: { createdAt: "desc" } });
    expect((v.issues as { code: string }[]).map((i) => i.code)).not.toContain("TIME_NOT_SPECIFIC");
  });

  it("the approval review captures the difference from the AI output", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await editCurrent(testDeps(), id, user.id, { requested_time_start: "09:00", requested_time_end: "11:00" });
    await approveCurrent(testDeps(), id, user.id, { comment: "Confirmed by phone" });
    const review = await db.review.findFirstOrThrow({ where: { workflowId: id } });
    expect((review.changes as { field: string }[]).map((c) => c.field)).toContain("requested_time_start");
    expect(review.comment).toBe("Confirmed by phone");
    expect(review.approvedFields).toMatchObject({ requested_time_start: "09:00" });
    const output = (await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } })).output as { body: string };
    expect(output.body).toContain("9:00 AM – 11:00 AM");
  });

  it("a human can supply missing data and then approve", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id, "Customer: Acme\n5 pallets of tile tomorrow at 9am. Call Sam 519-555-0100");
    await expect(approveCurrent(testDeps(), id, user.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await editCurrent(testDeps(), id, user.id, { address: "10 Main Street, Toronto, Ontario" });
    expect((await approveCurrent(testDeps(), id, user.id)).status).toBe("COMPLETED");
  });

  it("rejects invalid edits and no-op edits", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const args = { workflowId: id, userId: user.id, actor: actorOf(user.id) };
    await expect(editWorkflowFields(testDeps(), { ...args, updates: { requested_date: "Friday" } })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(editWorkflowFields(testDeps(), { ...args, updates: { webhook_url: "http://evil.test" } })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(editWorkflowFields(testDeps(), { ...args, updates: { customer: "ABC Building Supplies" } })).rejects.toMatchObject({ code: "NO_CHANGES" });
  });

  it("regression: values that merely round-trip through jsonb (key order) are not reported as edits", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    await expect(
      editCurrent(testDeps(), id, user.id, { items: [{ unit: "pallets", quantity: 4, description: "roofing shingles" }], customer: "ABC Building Supplies" }),
    ).rejects.toMatchObject({ code: "NO_CHANGES" });
  });

  it("regression: explicit times supersede a general window and resolve its ambiguity and contact concern", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const { changes } = await editCurrent(testDeps(), id, user.id, { requested_time_window: "morning", requested_time_start: "09:00", requested_time_end: "11:00", contact_phone: "519-555-0142" });
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
    await editCurrent(testDeps(), id, user.id, { items: [{ description: "shingles", quantity: -4, unit: "pallets" }] });
    await expect(approveCurrent(testDeps(), id, user.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("failure handling", () => {
  it("records a failed action, surfaces FAILED, and a retry succeeds without double-executing", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const failed = await approveCurrent(testDeps({ actions: new FailingActionProvider() }), id, user.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toBe("The confirmation service is unavailable.");
    expect(await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } })).toMatchObject({ status: "FAILED", error: "The confirmation service is unavailable." });

    const retried = await retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id) });
    expect(retried.status).toBe("COMPLETED");
    expect(await db.workflowAction.count({ where: { workflowId: id } })).toBe(1); // one outbox row, reused
    expect(await db.workflowAction.count({ where: { workflowId: id, status: "SUCCEEDED" } })).toBe(1);
    await expect(retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id) })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("does not leak internal error details into the workflow", async () => {
    const user = await makeUser();
    const boom = testDeps({ actions: { name: "x", mode: "simulated", execute: async () => Promise.reject(new Error("ECONNREFUSED 10.0.0.5:5432 password=hunter2")) }, maxJobAttempts: 1 });
    const { id } = await makeWorkflow(user.id);
    const w = await approveCurrent(boom, id, user.id);
    expect(w.status).toBe("FAILED");
    const blob = JSON.stringify([w, await db.auditEvent.findMany({ where: { workflowId: id } }), await db.workflowAction.findMany({ where: { workflowId: id } })]);
    expect(blob).not.toMatch(/hunter2|ECONNREFUSED|10\.0\.0\.5/);
  });
});

describe("database constraints", () => {
  it("refuses a child row whose owner differs from its workflow's owner", async () => {
    const [owner, other] = [await makeUser(), await makeUser()];
    const { id } = await makeWorkflow(owner.id);
    await expect(
      db.workflowAction.create({ data: { workflowId: id, userId: other.id, type: "CUSTOMER_CONFIRMATION", status: "SUCCEEDED", mode: "simulated", executedBy: other.id, idempotencyKey: `x-${id}` } }),
    ).rejects.toThrow();
    await expect(db.auditEvent.create({ data: { workflowId: id, userId: other.id, actorType: "USER", eventType: "X", message: "x" } })).rejects.toThrow();
    await expect(db.job.create({ data: { workflowId: id, userId: other.id, type: "EXECUTE_ACTION" } })).rejects.toThrow();
  });

  it("allows only one action row per workflow and one per idempotency key (schema-declared uniques)", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id);
    const data = { workflowId: id, userId: user.id, type: "CUSTOMER_CONFIRMATION", status: "PENDING", mode: "simulated", executedBy: user.id, idempotencyKey: `k-${id}` } as const;
    await db.workflowAction.create({ data });
    await expect(db.workflowAction.create({ data: { ...data, idempotencyKey: `k2-${id}` } })).rejects.toThrow(); // same workflow+type
    const other = await makeWorkflow(user.id, CLEAN_TEXT);
    await expect(db.workflowAction.create({ data: { ...data, workflowId: other.id, idempotencyKey: `k-${id}` } })).rejects.toThrow(); // same key
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
  });

  it("verifies the mock's own evidence: every present field is verified with a real source span", async () => {
    const user = await makeUser();
    const { id } = await makeWorkflow(user.id, CLEAN_TEXT);
    const stored = await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } });
    const status = stored.fieldStatus as Record<string, { verified?: boolean; span?: { start: number; end: number } | null; status: string }>;
    for (const f of ["customer", "address", "requested_date", "items", "contact_name", "contact_phone"]) {
      expect(status[f]?.verified, f).toBe(true);
      expect(status[f]?.span?.end, f).toBeGreaterThan(status[f]!.span!.start);
    }
  });
});
