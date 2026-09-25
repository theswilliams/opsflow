/**
 * F3 — workflows must never sit in limbo. Every test here simulates a crash/timeout window and proves the
 * workflow is recovered, retried a bounded number of times, or ends in an explicit FAILED state.
 */
import { describe, expect, it } from "vitest";
import type { AIProvider } from "@/lib/ai/provider";
import { ProviderError } from "@/lib/ai/provider";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import { getDb } from "@/lib/db";
import { assertLease, claimJob, LeaseLostError } from "@/lib/jobs/queue";
import { drainJobs, sweepStuckWork } from "@/lib/jobs/worker";
import { processWorkflowJob } from "@/lib/workflow/processing";
import { ActionError } from "@/lib/workflow/action-provider";
import { createWorkflow, editWorkflowFields, retryWorkflow, submitWorkflow } from "@/lib/workflow/service";
import { actorOf, approveCurrent, DELIVERY_TEXT, makeUser, NOW, RecordingActionProvider, testDeps, versionOf } from "./helpers";
import { SimulatedConfirmationProvider } from "@/lib/workflow/action-provider";

const db = getDb();
const later = (ms: number) => new Date(NOW.getTime() + ms);
const statusOf = async (id: string) => (await db.workflow.findUniqueOrThrow({ where: { id } })).status;
const jobOf = (workflowId: string, type: "PROCESS_WORKFLOW" | "EXECUTE_ACTION" = "PROCESS_WORKFLOW") => db.job.findUniqueOrThrow({ where: { workflowId_type: { workflowId, type } } });
const created = async (userId: string, text = DELIVERY_TEXT) =>
  (await createWorkflow(testDeps(), { userId, actor: actorOf(userId), source: "PASTE", kind: "text", text })).id;

class CountingProvider implements AIProvider {
  readonly name = "mock" as const;
  readonly isMock = true;
  calls = 0;
  private readonly inner = new MockAIProvider();
  constructor(private readonly hook?: () => Promise<void>) {}
  async extract(...args: Parameters<MockAIProvider["extract"]>) {
    this.calls++;
    await this.hook?.();
    return this.inner.extract(...args);
  }
}

describe("F3 · RECEIVED", () => {
  it("1+2. a crash right after creation leaves a queued job; the next worker processes it", async () => {
    const user = await makeUser("f3a");
    const id = await created(user.id); // process died here: created, never processed
    expect(await statusOf(id)).toBe("RECEIVED");
    expect((await jobOf(id)).status).toBe("QUEUED");
    await drainJobs(testDeps());
    expect(await statusOf(id)).toBe("REVIEW_REQUIRED");
  });

  it("2b. a RECEIVED workflow whose job is missing entirely is re-enqueued by the sweeper", async () => {
    const user = await makeUser("f3b");
    const id = await created(user.id);
    await db.job.deleteMany({ where: { workflowId: id } }); // legacy row / lost job
    const deps = testDeps({ now: () => later(10_000), orphanGraceMs: 1_000 });
    await db.workflow.update({ where: { id }, data: { updatedAt: NOW } });
    const swept = await sweepStuckWork(deps);
    expect(swept.reenqueued).toBeGreaterThanOrEqual(1);
    await drainJobs(deps);
    expect(await statusOf(id)).toBe("REVIEW_REQUIRED");
  });

  it("2c. Retry accepts a stalled RECEIVED workflow (the audit's 'Only failed workflows can be retried' dead end)", async () => {
    const user = await makeUser("f3c");
    const id = await created(user.id);
    await db.job.deleteMany({ where: { workflowId: id } });
    const w = await retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id) });
    expect(w.status).toBe("REVIEW_REQUIRED");
  });
});

describe("F3 · PROCESSING", () => {
  it("3+4. a crash during PROCESSING: the expired lease is swept back and the workflow completes on the next attempt", async () => {
    const user = await makeUser("f3d");
    const id = await created(user.id);
    // Worker A claims the job and marks the workflow PROCESSING... then dies.
    const dead = await claimJob(db, { workerId: "dead-worker", leaseMs: 1_000, now: NOW, workflowId: id });
    expect(dead).not.toBeNull();
    await db.workflow.update({ where: { id }, data: { status: "PROCESSING" } });

    // Before the lease expires nothing else may take the job.
    expect(await claimJob(db, { workerId: "w2", leaseMs: 1_000, now: NOW, workflowId: id })).toBeNull();
    expect((await sweepStuckWork(testDeps({ now: () => NOW }))).requeued).toBe(0);

    const deps = testDeps({ now: () => later(5_000) });
    const swept = await sweepStuckWork(deps);
    expect(swept.requeued).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe("RECEIVED");
    expect((await jobOf(id)).status).toBe("QUEUED");
    await drainJobs(deps);
    expect(await statusOf(id)).toBe("REVIEW_REQUIRED");
    expect((await jobOf(id)).attempts).toBe(2);
  });

  it("5. AI slower than the HTTP request budget: the request returns, the workflow is NOT lost, and finishes in the background", async () => {
    const user = await makeUser("f3e");
    const slow = new CountingProvider(() => new Promise((r) => setTimeout(r, 400)));
    const deps = testDeps({ ai: slow, inlineTimeoutMs: 50 });
    const t0 = Date.now();
    const c = await submitWorkflow(deps, { userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT });
    expect(Date.now() - t0).toBeLessThan(350); // responded before the AI finished
    expect(await statusOf(c.id)).toBe("PROCESSING");
    expect((await jobOf(c.id)).status).toBe("RUNNING"); // owned, leased
    await expect.poll(() => statusOf(c.id), { timeout: 5_000, interval: 50 }).toBe("REVIEW_REQUIRED");
  });

  it("6. an exception during validation/persistence does not strand the workflow", async () => {
    const user = await makeUser("f3f");
    const id = await created(user.id);
    // An invalid timezone makes validation throw AFTER the AI call succeeded.
    await drainJobs(testDeps({ timezone: "Not/AZone" }));
    const w = await db.workflow.findUniqueOrThrow({ where: { id } });
    expect(w.status).toBe("FAILED"); // explicit, never VALIDATING/PROCESSING
    expect(w.failureReason).toMatch(/Gave up after 3 attempts/);
    expect((await jobOf(id)).status).toBe("FAILED");
    // ...and it is recoverable once the cause is fixed:
    expect((await retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id) })).status).toBe("REVIEW_REQUIRED");
  });

  it("6b. an exception while validating an EDIT leaves the workflow editable in REVIEW_REQUIRED at the same version", async () => {
    const user = await makeUser("f3g");
    const c = await submitWorkflow(testDeps(), { userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT });
    const v = await versionOf(c.id);
    await expect(
      editWorkflowFields(testDeps({ timezone: "Not/AZone" }), { workflowId: c.id, userId: user.id, actor: actorOf(user.id), updates: { customer: "Changed Co" }, expectedVersion: v }),
    ).rejects.toThrow();
    expect(await statusOf(c.id)).toBe("REVIEW_REQUIRED");
    expect(await versionOf(c.id)).toBe(v);
    const ok = await editWorkflowFields(testDeps(), { workflowId: c.id, userId: user.id, actor: actorOf(user.id), updates: { customer: "Changed Co" }, expectedVersion: v });
    expect(ok.version).toBe(v + 1);
  });

  it("10. bounded retries: transient provider failures end in an explicit FAILED state after maxAttempts", async () => {
    const user = await makeUser("f3h");
    const failing: AIProvider = { name: "mock", isMock: true, extract: async () => Promise.reject(new ProviderError("down", "unavailable", true)) };
    const deps = testDeps({ ai: failing, maxJobAttempts: 2 });
    const c = await submitWorkflow(deps, { userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT });
    await drainJobs(deps);
    const w = await db.workflow.findUniqueOrThrow({ where: { id: c.id } });
    expect(w.status).toBe("FAILED");
    expect(w.failureReason).toMatch(/Gave up after 2 attempts/);
    const job = await jobOf(c.id);
    expect(job).toMatchObject({ status: "FAILED", attempts: 2 });
    await drainJobs(deps); // nothing left to run: no retry loop
    expect((await jobOf(c.id)).attempts).toBe(2);
  });

  it("a lease that expires with attempts exhausted becomes FAILED, not an eternal retry", async () => {
    const user = await makeUser("f3i");
    const id = await created(user.id);
    await db.job.update({ where: { workflowId_type: { workflowId: id, type: "PROCESS_WORKFLOW" } }, data: { maxAttempts: 1 } });
    await claimJob(db, { workerId: "dead", leaseMs: 1, now: NOW, workflowId: id });
    await db.workflow.update({ where: { id }, data: { status: "PROCESSING" } });
    const deps = testDeps({ now: () => later(1_000) });
    expect((await sweepStuckWork(deps)).failed).toBe(1);
    const w = await db.workflow.findUniqueOrThrow({ where: { id } });
    expect(w).toMatchObject({ status: "FAILED", needsAttention: true });
    expect(w.failureReason).toMatch(/did not complete/);
  });
});

describe("F3 · concurrency and fencing", () => {
  it("8. concurrent workers never process the same job twice", async () => {
    const user = await makeUser("f3j");
    const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => created(user.id, `${DELIVERY_TEXT}\nRef ${i}`)));
    const provider = new CountingProvider();
    const workers = ["w1", "w2", "w3", "w4"].map((w) => testDeps({ ai: provider, workerId: w }));
    await Promise.all(workers.map((d) => drainJobs(d, 20)));
    for (const id of ids) {
      expect(await statusOf(id)).toBe("REVIEW_REQUIRED");
      expect(await db.extractedData.count({ where: { workflowId: id } })).toBe(1);
      expect((await jobOf(id)).attempts).toBe(1);
    }
    expect(provider.calls).toBe(6); // exactly one AI call per workflow
  });

  it("8b. ten simultaneous claims of one job: exactly one wins", async () => {
    const user = await makeUser("f3k");
    const id = await created(user.id);
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => claimJob(db, { workerId: `c${i}`, leaseMs: 60_000, now: NOW, workflowId: id })));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("9. retry is idempotent: repeated/concurrent retries never create duplicate work", async () => {
    const user = await makeUser("f3l");
    const c = await submitWorkflow(testDeps({ ai: { name: "mock", isMock: true, extract: async () => Promise.reject(new ProviderError("x", "auth", false)) } }), {
      userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT,
    });
    expect(await statusOf(c.id)).toBe("FAILED");
    const provider = new CountingProvider();
    const results = await Promise.allSettled([1, 2, 3].map(() => retryWorkflow(testDeps({ ai: provider }), { workflowId: c.id, userId: user.id, actor: actorOf(user.id) })).flat());
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await statusOf(c.id)).toBe("REVIEW_REQUIRED");
    expect(await db.job.count({ where: { workflowId: c.id } })).toBe(1);
    expect(provider.calls).toBe(1);
  });

  it("11. a stale worker cannot overwrite newer state (fencing)", async () => {
    const user = await makeUser("f3m");
    const id = await created(user.id);
    let staleDeps!: ReturnType<typeof testDeps>;
    // Worker A: while its AI call is in flight, its lease expires, the sweeper requeues, and worker B finishes the job.
    const providerA = new CountingProvider(async () => {
      const laterDeps = testDeps({ now: () => later(120_000), workerId: "worker-B" });
      await sweepStuckWork(laterDeps);
      await drainJobs(laterDeps);
    });
    staleDeps = testDeps({ ai: providerA, workerId: "worker-A", leaseMs: 1_000 });
    const jobA = await claimJob(db, { workerId: "worker-A", leaseMs: 1_000, now: NOW, workflowId: id });
    await processWorkflowJob(staleDeps, jobA!);

    // B won: exactly one result, produced by B's attempt (attempts = 2).
    expect(await statusOf(id)).toBe("REVIEW_REQUIRED");
    expect(await db.extractedData.count({ where: { workflowId: id } })).toBe(1);
    expect(await db.validationResult.count({ where: { workflowId: id } })).toBe(1);
    expect((await jobOf(id)).attempts).toBe(2);
    expect(await db.auditEvent.count({ where: { workflowId: id, eventType: "EXTRACTION_COMPLETED" } })).toBe(1);
    // ...and A's token is rejected by every fenced write.
    await expect(db.$transaction((tx) => assertLease(tx, jobA!))).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe("F3 · EXECUTING", () => {
  it("7. transient action failures are retried with the same idempotency key and never strand the workflow", async () => {
    const user = await makeUser("f3n");
    const c = await submitWorkflow(testDeps(), { userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT });
    let calls = 0;
    const recording = new RecordingActionProvider(new SimulatedConfirmationProvider(db));
    const flaky = {
      name: "flaky",
      mode: "simulated" as const,
      execute: async (ctx: Parameters<typeof recording.execute>[0], o: { idempotencyKey: string }) => {
        if (++calls <= 2) throw new Error("socket hang up"); // NOT an ActionError: outcome unknown
        return recording.execute(ctx, o);
      },
    };
    const deps = testDeps({ actions: flaky });
    const first = await approveCurrent(deps, c.id, user.id);
    expect(first.status).toBe("APPROVED"); // requeued, not stuck in EXECUTING
    await drainJobs(deps);
    const done = await db.workflow.findUniqueOrThrow({ where: { id: c.id } });
    expect(done.status).toBe("COMPLETED");
    expect(recording.sent).toBe(1);
    expect(new Set(recording.keysSeen).size).toBe(1);
  });

  it("7b. exhausted action attempts end in FAILED with the action row marked FAILED", async () => {
    const user = await makeUser("f3o");
    const c = await submitWorkflow(testDeps(), { userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT });
    const deps = testDeps({ actions: { name: "down", mode: "simulated", execute: async () => Promise.reject(new Error("timeout")) }, maxJobAttempts: 2 });
    await approveCurrent(deps, c.id, user.id);
    await drainJobs(deps);
    const w = await db.workflow.findUniqueOrThrow({ where: { id: c.id } });
    expect(w.status).toBe("FAILED");
    expect(w.failureReason).toMatch(/could not be confirmed/);
    expect((await db.workflowAction.findFirstOrThrow({ where: { workflowId: c.id } })).status).toBe("FAILED");
    expect((await jobOf(c.id, "EXECUTE_ACTION")).status).toBe("FAILED");
  });

  it("an EXECUTING workflow whose worker died is re-queued by the sweeper and completes exactly once", async () => {
    const user = await makeUser("f3p");
    const c = await submitWorkflow(testDeps(), { userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT });
    await approveCurrent(testDeps(), c.id, user.id, { run: false });
    const dead = await claimJob(db, { workerId: "dead", leaseMs: 1_000, now: NOW, workflowId: c.id, type: "EXECUTE_ACTION" });
    expect(dead).not.toBeNull();
    await db.workflow.update({ where: { id: c.id }, data: { status: "EXECUTING" } });
    await db.workflowAction.updateMany({ where: { workflowId: c.id }, data: { status: "EXECUTING" } });

    const deps = testDeps({ now: () => later(5_000) });
    expect((await sweepStuckWork(deps)).requeued).toBeGreaterThanOrEqual(1);
    expect(await statusOf(c.id)).toBe("APPROVED");
    await drainJobs(deps);
    expect(await statusOf(c.id)).toBe("COMPLETED");
    expect(await db.providerDelivery.count({ where: { idempotencyKey: { contains: c.id } } })).toBe(1);
  });

  it("a definitive provider refusal (ActionError) fails immediately without wasting retries", async () => {
    const user = await makeUser("f3q");
    const c = await submitWorkflow(testDeps(), { userId: user.id, actor: actorOf(user.id), source: "PASTE", kind: "text", text: DELIVERY_TEXT });
    let calls = 0;
    const deps = testDeps({ actions: { name: "no", mode: "simulated", execute: async () => { calls++; throw new ActionError("Recipient blocked."); } } });
    const w = await approveCurrent(deps, c.id, user.id);
    expect(w.status).toBe("FAILED");
    expect(calls).toBe(1);
  });
});
