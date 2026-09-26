/**
 * F4 — approval must be bound to the version the reviewer actually saw.
 */
import { describe, expect, it } from "vitest";
import type { ExtractedFields } from "@/lib/ai/schema";
import { getDb } from "@/lib/db";
import { approveWorkflow, editWorkflowFields, rejectWorkflow } from "@/lib/workflow/service";
import { actorOf, approveCurrent, editCurrent, makeUser, makeWorkflow, testDeps, versionOf } from "./helpers";

const db = getDb();
const TEXT = "Customer: Acme\n2 pallets of brick to 480 Wellington Road, London, Ontario on 2026-10-06 at 9am. Call Sam 519-555-0100.";
const noSideEffects = async (id: string) => {
  expect(await db.workflowAction.count({ where: { workflowId: id } })).toBe(0);
  expect(await db.providerDelivery.count({ where: { idempotencyKey: { contains: id } } })).toBe(0);
  expect(await db.review.count({ where: { workflowId: id } })).toBe(0);
};

describe("F4 · two-tab attack from the audit", () => {
  it("2-6. tab A sees 480 Wellington Road; tab B changes the address; tab A's approval is rejected and nothing is sent; after reload the new version is approved", async () => {
    const user = await makeUser("f4a");
    const { id } = await makeWorkflow(user.id, TEXT);

    // Tab A loads the page: it sees this version.
    const seenByA = await versionOf(id);
    const fieldsA = (await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } })).fields as unknown as ExtractedFields;
    expect(fieldsA.address).toContain("480 Wellington Road");

    // Tab B (or a second reviewer) edits the address.
    await editWorkflowFields(testDeps(), { workflowId: id, userId: user.id, actor: actorOf("someone-else"), updates: { address: "1 Wrong Street, Toronto, Ontario" }, expectedVersion: seenByA });
    expect(await versionOf(id)).toBe(seenByA + 1);

    // Tab A clicks Approve with the version it saw.
    await expect(approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: seenByA })).rejects.toMatchObject({
      code: "STALE_VERSION",
      userMessage: expect.stringMatching(/changed after you opened it/i),
    });
    await noSideEffects(id);
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("REVIEW_REQUIRED");

    // Reviewer reloads, sees the new address, and approves THAT version.
    const done = await approveCurrent(testDeps(), id, user.id);
    expect(done.status).toBe("COMPLETED");
    const out = (await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } })).output as { body: string };
    expect(out.body).toContain("1 Wrong Street, Toronto, Ontario"); // what the reviewer just saw and approved
    expect(await db.review.findFirstOrThrow({ where: { workflowId: id } })).toMatchObject({ approvedVersion: seenByA + 1 });
  });

  it("the stale approval also cannot slip through via the same version after the edit is reverted", async () => {
    const user = await makeUser("f4b");
    const { id } = await makeWorkflow(user.id, TEXT);
    const v1 = await versionOf(id);
    await editCurrent(testDeps(), id, user.id, { address: "9 Other Street, Toronto, Ontario" });
    await editCurrent(testDeps(), id, user.id, { address: "480 Wellington Road, London, Ontario" }); // back to the original text
    // Same CONTENT as v1 but a different version: A/B/A must not be approvable with v1.
    await expect(approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: v1 })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await noSideEffects(id);
  });

  it("7. edit and approval racing each other: exactly one wins, and what executes is exactly what was approved", async () => {
    for (let i = 0; i < 8; i++) {
      const user = await makeUser(`f4r${i}`);
      const { id } = await makeWorkflow(user.id, TEXT);
      const v = await versionOf(id);
      const [approve, edit] = await Promise.allSettled([
        approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: v }),
        editWorkflowFields(testDeps(), { workflowId: id, userId: user.id, actor: actorOf("b"), updates: { address: "1 Wrong Street, Toronto, Ontario" }, expectedVersion: v }),
      ]);
      // Never both.
      expect([approve.status, edit.status].filter((s) => s === "fulfilled")).toHaveLength(1);

      const review = await db.review.findFirst({ where: { workflowId: id } });
      const action = await db.workflowAction.findFirst({ where: { workflowId: id } });
      if (approve.status === "fulfilled") {
        // Approval won: the executed data is the ORIGINAL address, and the edit was refused.
        expect((review!.approvedFields as unknown as ExtractedFields).address).toContain("480 Wellington Road");
        expect(JSON.stringify(action?.output)).toContain("480 Wellington Road");
        expect(JSON.stringify(action?.output)).not.toContain("Wrong Street");
        expect((edit as PromiseRejectedResult).reason.code).toMatch(/STALE_VERSION|INVALID_STATE|CONFLICT/);
      } else {
        // Edit won: nothing was approved or sent.
        expect((approve as PromiseRejectedResult).reason.code).toMatch(/STALE_VERSION|INVALID_STATE|CONFLICT/);
        await noSideEffects(id);
      }
    }
  });

  it("8. approving the same version twice at once executes once", async () => {
    const user = await makeUser("f4c");
    const { id } = await makeWorkflow(user.id, TEXT);
    const v = await versionOf(id);
    const args = { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: v };
    const results = await Promise.allSettled([approveWorkflow(testDeps(), args), approveWorkflow(testDeps(), args), approveWorkflow(testDeps(), args)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.providerDelivery.count({ where: { idempotencyKey: { contains: id } } })).toBe(1);
  });
});

describe("F4 · what counts as a version change", () => {
  it("9. non-material actions do not bump the version: no-op edits, approval comments, failed edits", async () => {
    const user = await makeUser("f4d");
    const { id } = await makeWorkflow(user.id, TEXT);
    const v = await versionOf(id);
    await expect(editCurrent(testDeps(), id, user.id, { customer: "Acme" })).rejects.toMatchObject({ code: "NO_CHANGES" });
    await expect(editCurrent(testDeps(), id, user.id, { requested_date: "not-a-date" })).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(await versionOf(id)).toBe(v);
    // A reviewer who loaded before those no-op attempts can still approve, with a comment.
    const done = await approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: v, comment: "OK by phone" });
    expect(done.status).toBe("COMPLETED");
  });

  it("every material edit bumps the version by exactly one, and an edit with a stale version is refused too (no lost updates)", async () => {
    const user = await makeUser("f4e");
    const { id } = await makeWorkflow(user.id, TEXT);
    const v = await versionOf(id);
    await editCurrent(testDeps(), id, user.id, { customer: "Acme Two" });
    expect(await versionOf(id)).toBe(v + 1);
    await expect(
      editWorkflowFields(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), updates: { special_instructions: "Use side gate" }, expectedVersion: v }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(await versionOf(id)).toBe(v + 1);
  });

  it("10. the executed action uses the frozen approval snapshot, not whatever the live row says later", async () => {
    const user = await makeUser("f4f");
    const { id } = await makeWorkflow(user.id, TEXT);
    const failing = testDeps({ actions: { name: "down", mode: "simulated", execute: async () => Promise.reject(new Error("net")) }, maxJobAttempts: 1 });
    expect((await approveCurrent(failing, id, user.id)).status).toBe("FAILED");
    // Someone (or a bug) tampers with the live extracted row after approval.
    const row = await db.extractedData.findUniqueOrThrow({ where: { workflowId: id } });
    await db.extractedData.update({ where: { workflowId: id }, data: { fields: { ...(row.fields as object), address: "666 Tampered Ave, Toronto, Ontario" } } });
    const { retryWorkflow } = await import("@/lib/workflow/service");
    await retryWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id) });
    const out = (await db.workflowAction.findFirstOrThrow({ where: { workflowId: id } })).output as { body: string };
    expect(out.body).toContain("480 Wellington Road");
    expect(out.body).not.toContain("Tampered");
  });

  it("11. approve requires a version; reject honours it when given", async () => {
    const user = await makeUser("f4g");
    const { id } = await makeWorkflow(user.id, TEXT);
    // @ts-expect-error — deliberately omitted
    await expect(approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id) })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(approveWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: Number.NaN })).rejects.toMatchObject({ code: "BAD_INPUT" });
    const v = await versionOf(id);
    await editCurrent(testDeps(), id, user.id, { customer: "Acme Two" });
    await expect(rejectWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: v })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await rejectWorkflow(testDeps(), { workflowId: id, userId: user.id, actor: actorOf(user.id), expectedVersion: await versionOf(id) });
    expect((await db.workflow.findUniqueOrThrow({ where: { id } })).status).toBe("REJECTED");
  });

  it("the review page's validation is recomputed, so 'Approve' never looks valid when the server would refuse (date rolled over)", async () => {
    const user = await makeUser("f4h");
    const { id } = await makeWorkflow(user.id, TEXT);
    const { currentValidation } = await import("@/lib/workflow/service");
    const tomorrow = new Date(Date.UTC(2026, 9, 7, 15)); // the day after the requested delivery date
    const fresh = await currentValidation(testDeps({ now: () => tomorrow }), user.id, id);
    expect(fresh.passed).toBe(false);
    expect(fresh.issues.map((i) => i.code)).toContain("DATE_IN_PAST");
    await expect(approveCurrent(testDeps({ now: () => tomorrow }), id, user.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
