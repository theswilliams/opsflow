import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { attentionRequired, dashboardStats, getWorkflowDetail, listWorkflows, recentActivity } from "@/lib/workflow/queries";
import { approveWorkflow, editWorkflowFields, executeApprovedWorkflow, processWorkflow, rejectWorkflow, retryWorkflow } from "@/lib/workflow/service";
import { makeUser, makeWorkflow, testDeps } from "./helpers";

const db = getDb();

describe("tenant isolation (IDOR / BOLA)", async () => {
  const alice = await makeUser("alice");
  const mallory = await makeUser("mallory");
  const aw = await makeWorkflow(alice.id);
  const mw = await makeWorkflow(mallory.id);
  const asMallory = { workflowId: aw.id, userId: mallory.id, actor: { type: "USER", id: mallory.id } } as const;

  it("a user can read their own workflow", async () => {
    const detail = await getWorkflowDetail(db, alice.id, aw.id);
    expect(detail?.id).toBe(aw.id);
    expect(detail?.auditEvents.length).toBeGreaterThan(0);
  });

  it("a user cannot read another user's workflow (indistinguishable from not found)", async () => {
    expect(await getWorkflowDetail(db, mallory.id, aw.id)).toBeNull();
    expect(await getWorkflowDetail(db, mallory.id, "does-not-exist")).toBeNull();
  });

  it("lists, dashboard stats, attention and activity only include own data", async () => {
    const list = await listWorkflows(db, mallory.id, {});
    expect(list.rows.map((r) => r.id)).toEqual([mw.id]);
    expect((await listWorkflows(db, mallory.id, { q: "ABC" })).rows.every((r) => r.userId === mallory.id)).toBe(true);
    expect((await dashboardStats(db, mallory.id)).total).toBe(1);
    expect((await attentionRequired(db, mallory.id)).every((w) => w.userId === mallory.id)).toBe(true);
    expect((await recentActivity(db, mallory.id, 50)).every((e) => e.userId === mallory.id)).toBe(true);
  });

  it("searching by another user's id fragment does not reveal it", async () => {
    const list = await listWorkflows(db, mallory.id, { q: aw.id.slice(-8) });
    expect(list.rows).toEqual([]);
  });

  it("no mutation works across tenants, and nothing changes", async () => {
    const before = await db.workflow.findUniqueOrThrow({ where: { id: aw.id } });
    const deps = testDeps();
    await expect(editWorkflowFields(deps, { ...asMallory, updates: { customer: "Hacked" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(approveWorkflow(deps, asMallory)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rejectWorkflow(deps, asMallory)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(executeApprovedWorkflow(deps, asMallory)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(retryWorkflow(deps, asMallory)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(processWorkflow(deps, asMallory)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const after = await db.workflow.findUniqueOrThrow({ where: { id: aw.id } });
    expect(after).toEqual(before);
    expect(await db.review.count({ where: { workflowId: aw.id } })).toBe(0);
    expect(await db.workflowAction.count({ where: { workflowId: aw.id } })).toBe(0);
  });
});
