/**
 * F5 — the customer action must never be performed twice, even if the database commit that follows the
 * external side effect fails. Uses a provider that behaves like a real idempotent API (Stripe/SES style) and
 * counts REAL side effects separately from calls.
 */
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { claimJob } from "@/lib/jobs/queue";
import { drainJobs, sweepStuckWork } from "@/lib/jobs/worker";
import { SimulatedConfirmationProvider } from "@/lib/workflow/action-provider";
import { processWorkflowJob } from "@/lib/workflow/processing";
import { executeActionJob } from "@/lib/workflow/execution";
import { retryWorkflow } from "@/lib/workflow/service";
import { actorOf, approveCurrent, editCurrent, makeUser, NOW, RecordingActionProvider, testDeps } from "./helpers";
import { makeWorkflow } from "./helpers";

const db = getDb();

/** Wraps a db so the Nth `$transaction` call throws (a commit that "fails" after the side effect happened). */
function failingCommit(failOn: number) {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        return (...args: unknown[]) => {
          n++;
          if (n === failOn) return Promise.reject(new Error("simulated commit failure (connection reset)"));
          return (target.$transaction as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as typeof db;
  return { db: proxy, calls: () => n };
}

const setup = async (label: string) => {
  const user = await makeUser(label);
  const { id } = await makeWorkflow(user.id);
  const recording = new RecordingActionProvider(new SimulatedConfirmationProvider(db));
  return { user, id, recording };
};

describe("F5 · action outbox", () => {
  it("1-5. action succeeds, the DB commit fails, the retry reuses the same idempotency key, and only ONE side effect happens", async () => {
    const { user, id, recording } = await setup("f5a");
    // approve without running; then run the executor with a db whose SECOND transaction (the completion commit) fails.
    await approveCurrent(testDeps({ actions: recording }), id, user.id, { run: false });
    const flaky = failingCommit(2);
    const deps = testDeps({ actions: recording, db: flaky.db });
    const job = await claimJob(db, { workerId: deps.workerId, leaseMs: 60_000, now: NOW, workflowId: id, type: "EXECUTE_ACTION" });
    await executeActionJob(deps, job!);

    // The email WAS sent, but the database never learned about it...
    expect(recording.sent).toBe(1);
    const w1 = await db.workflow.findUniqueOrThrow({ where: { id } });
    expect(w1.status).toBe("APPROVED"); // requeued for retry, not marked FAILED, not lost
    const a1 = await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } });
    expect(a1.status).toBe("EXECUTING"); // durable "may have been sent" record

    // ...so the retry must reuse the same key, and the provider must not send again.
    await drainJobs(testDeps({ actions: recording }));
    expect(recording.sent).toBe(1); // still exactly one real side effect
    expect(recording.keysSeen).toHaveLength(2);
    expect(new Set(recording.keysSeen).size).toBe(1);
    expect(recording.keysSeen[0]).toBe(a1.idempotencyKey);
    const w2 = await db.workflow.findUniqueOrThrow({ where: { id } });
    expect(w2.status).toBe("COMPLETED");
    expect(await db.workflowAction.count({ where: { workflowId: id } })).toBe(1); // one logical action
    expect(await db.workflowAction.count({ where: { workflowId: id, status: "SUCCEEDED" } })).toBe(1);
    expect(await db.providerDelivery.count({ where: { idempotencyKey: a1.idempotencyKey } })).toBe(1);
  });

  it("the retry after a failed commit still succeeds if the failure repeats once more", async () => {
    const { user, id, recording } = await setup("f5b");
    await approveCurrent(testDeps({ actions: recording }), id, user.id, { run: false });
    for (const failOn of [2, 2]) {
      const flaky = failingCommit(failOn);
      const job = await claimJob(db, { workerId: "w", leaseMs: 60_000, now: NOW, workflowId: id, type: "EXECUTE_ACTION" });
      if (!job) break;
      await executeActionJob(testDeps({ actions: recording, db: flaky.db, workerId: "w" }), job);
    }
    await drainJobs(testDeps({ actions: recording }));
    expect(recording.sent).toBe(1);
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
  });

  it("6. concurrent retries: two workers racing for the same action produce one side effect", async () => {
    const { user, id, recording } = await setup("f5c");
    await approveCurrent(testDeps({ actions: recording }), id, user.id, { run: false });
    await Promise.all(["A", "B", "C"].map((w) => drainJobs(testDeps({ actions: recording, workerId: `worker-${w}` }))));
    expect(recording.sent).toBe(1);
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
  });

  it("a duplicate EXECUTE job for an already-completed workflow does nothing", async () => {
    const { user, id, recording } = await setup("f5d");
    await approveCurrent(testDeps({ actions: recording }), id, user.id);
    expect(recording.sent).toBe(1);
    await enqueueJob(db, { userId: user.id, workflowId: id, type: "EXECUTE_ACTION", maxAttempts: 3 });
    await drainJobs(testDeps({ actions: recording }));
    expect(recording.sent).toBe(1);
    expect(recording.keysSeen).toHaveLength(1); // the executor did not even call the provider
  });

  it("a worker that loses its lease AFTER the provider call cannot double-send, and cannot overwrite the winner", async () => {
    const { user, id, recording } = await setup("f5e");
    await approveCurrent(testDeps({ actions: recording }), id, user.id, { run: false });
    const jobA = await claimJob(db, { workerId: "worker-A", leaseMs: 1_000, now: NOW, workflowId: id, type: "EXECUTE_ACTION" });
    // A's provider call succeeds, but during it the lease expires and worker B takes over and finishes.
    let reentered = false;
    const providerA = {
      name: "A",
      mode: "simulated" as const,
      execute: async (ctx: Parameters<typeof recording.execute>[0], o: { idempotencyKey: string }) => {
        const result = await recording.execute(ctx, o); // A's side effect
        if (!reentered) {
          reentered = true;
          const later = testDeps({ actions: recording, workerId: "worker-B", now: () => new Date(NOW.getTime() + 60_000) });
          await sweepStuckWork(later);
          await drainJobs(later);
        }
        return result;
      },
    };
    await executeActionJob(testDeps({ actions: providerA, workerId: "worker-A" }), jobA!);
    expect(recording.sent).toBe(1); // A sent; B's call with the same key was de-duplicated by the provider
    expect(new Set(recording.keysSeen).size).toBe(1);
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
    expect(await db.auditEvent.count({ where: { workflowId: id, eventType: "ACTION_EXECUTED" } })).toBe(1); // A's stale commit was fenced off
  });

  it("the idempotency key is deterministic per (workflow, approved version), so a new approval version gets a new key", async () => {
    const user = await makeUser("f5f");
    const { id } = await makeWorkflow(user.id);
    await editCurrent(testDeps(), id, user.id, { customer: "Renamed Co" });
    const w = await approveCurrent(testDeps(), id, user.id);
    const action = await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } });
    expect(action.idempotencyKey).toBe(`wf:${id}:customer_confirmation:v${w.version}`);
    expect(w.version).toBeGreaterThan(2);
  });

  it("manual 'Retry action' after a definitive failure reuses the outbox row and key (no new row, no double send)", async () => {
    const { user, id, recording } = await setup("f5g");
    const down = { name: "down", mode: "simulated" as const, execute: async () => Promise.reject(new Error("net")) };
    await approveCurrent(testDeps({ actions: down, maxJobAttempts: 1 }), id, user.id);
    const failedAction = await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } });
    expect(failedAction.status).toBe("FAILED");
    const retried = await retryWorkflow(testDeps({ actions: recording }), { workflowId: id, userId: user.id, actor: actorOf(user.id) });
    expect(retried.status).toBe("COMPLETED");
    expect(recording.keysSeen).toEqual([failedAction.idempotencyKey]);
    expect(await db.workflowAction.count({ where: { workflowId: id } })).toBe(1);
  });

  it("processing jobs are just as safe to re-run: processing an already-processed workflow twice keeps one result", async () => {
    const { id, user } = await setup("f5h");
    await enqueueJob(db, { userId: user.id, workflowId: id, type: "PROCESS_WORKFLOW", maxAttempts: 3 });
    const job = await claimJob(db, { workerId: "w", leaseMs: 60_000, now: NOW, workflowId: id, type: "PROCESS_WORKFLOW" });
    await processWorkflowJob(testDeps({ workerId: "w" }), job!);
    expect(await db.extractedData.count({ where: { workflowId: id } })).toBe(1);
  });
});
