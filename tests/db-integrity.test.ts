/**
 * F7 + F8 — database safeguards exist after a clean migration, cannot be dropped by a careless generated
 * migration, and the audit log behaves exactly as documented (append-only for the application; deletion only via
 * the explicit maintenance path; never as a cascade side effect).
 */
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { deleteAccount, purgeExpiredContent } from "@/lib/privacy";
import { withAuditMaintenance } from "@/lib/workflow/audit";
// @ts-expect-error — plain ESM helper shared with the CI script
import { findDroppedSafeguards, PROTECTED } from "../scripts/lib/migration-guard.mjs";
import { makeUser, makeWorkflow, NOW } from "./helpers";

const db = getDb();

async function catalog() {
  const q = async (sql: string) => (await db.$queryRawUnsafe<{ name: string }[]>(sql)).map((r) => r.name);
  return new Set([
    ...(await q(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'`)),
    ...(await q(`SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal`)),
    ...(await q(`SELECT conname AS name FROM pg_constraint`)),
    ...(await q(`SELECT proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)),
  ]);
}

describe("F8 · migration integrity", () => {
  it("every protected safeguard exists in a database built purely from the migrations", async () => {
    const present = await catalog();
    const missing = (PROTECTED as string[]).filter((n) => !present.has(n));
    expect(missing).toEqual([]);
  });

  it("the previously hand-written partial index is gone: uniqueness is now declared in schema.prisma", async () => {
    const present = await catalog();
    expect(present.has("WorkflowAction_one_success_per_workflow")).toBe(false);
    expect(present.has("Review_one_decision_per_workflow")).toBe(false);
    const idx = await db.$queryRawUnsafe<{ indexdef: string }[]>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'WorkflowAction_workflowId_type_key'`);
    expect(idx[0]?.indexdef).toMatch(/UNIQUE/);
    expect(idx[0]?.indexdef).not.toMatch(/WHERE/); // a full unique index, not a partial one
  });

  it("the migration guard flags a migration that would drop a safeguard, and ignores harmless ones", () => {
    expect(findDroppedSafeguards(`DROP INDEX "Review_workflowId_key";`)).toEqual(["Review_workflowId_key"]);
    expect(findDroppedSafeguards(`DROP TRIGGER "AuditEvent_guard_row" ON "AuditEvent";`)).toEqual(["AuditEvent_guard_row"]);
    expect(findDroppedSafeguards(`ALTER TABLE "User" DROP CONSTRAINT "User_email_lowercase";`)).toEqual(["User_email_lowercase"]);
    expect(findDroppedSafeguards(`DROP INDEX "Workflow_status_idx";`)).toEqual([]);
    // dropped and re-created in the same migration (e.g. an FK re-add) is fine
    expect(findDroppedSafeguards(`ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_userId_fkey";\nALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id");`)).toEqual([]);
    // comments do not count
    expect(findDroppedSafeguards(`-- DROP INDEX "Review_workflowId_key";`)).toEqual([]);
  });

  it("audit and job foreign keys are RESTRICT / tenant-consistent", async () => {
    const rows = await db.$queryRawUnsafe<{ name: string; del: string }[]>(
      `SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE conname IN ('AuditEvent_userId_fkey','AuditEvent_workflowId_userId_fkey')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.del === "r")).toBe(true); // 'r' = RESTRICT
  });
});

describe("F7 · audit log guarantees (what is actually promised)", () => {
  it("UPDATE, DELETE and TRUNCATE are refused for the application", async () => {
    const user = await makeUser("f7a");
    const { id } = await makeWorkflow(user.id);
    const event = await db.auditEvent.findFirstOrThrow({ where: { workflowId: id } });
    await expect(db.auditEvent.update({ where: { id: event.id }, data: { message: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.updateMany({ where: { workflowId: id }, data: { message: "x" } })).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.deleteMany({ where: { workflowId: id } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`TRUNCATE TABLE "AuditEvent"`)).rejects.toThrow(/append-only/);
    expect((await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).message).toBe(event.message);
  });

  it("appending still works", async () => {
    const user = await makeUser("f7b");
    const { id } = await makeWorkflow(user.id);
    await db.auditEvent.create({ data: { workflowId: id, userId: user.id, actorType: "SYSTEM", eventType: "NOTE", message: "ok" } });
  });

  it("deleting a workflow or user with history is refused: audit records are never a cascade side effect", async () => {
    const user = await makeUser("f7c");
    const { id } = await makeWorkflow(user.id);
    const before = await db.auditEvent.count({ where: { userId: user.id } });
    await expect(db.workflow.delete({ where: { id } })).rejects.toThrow();
    await expect(db.user.delete({ where: { id: user.id } })).rejects.toThrow();
    expect(await db.auditEvent.count({ where: { userId: user.id } })).toBe(before);
    expect(await db.workflow.count({ where: { id } })).toBe(1);
  });

  it("the maintenance path is the only way through, and it is scoped to its own transaction", async () => {
    const user = await makeUser("f7d");
    const { id } = await makeWorkflow(user.id);
    await withAuditMaintenance(db, async (tx) => {
      await tx.auditEvent.updateMany({ where: { workflowId: id }, data: { metadata: { redacted: true } } });
    });
    expect((await db.auditEvent.findFirstOrThrow({ where: { workflowId: id } })).metadata).toEqual({ redacted: true });
    // The flag did not leak past the transaction:
    await expect(db.auditEvent.updateMany({ where: { workflowId: id }, data: { message: "x" } })).rejects.toThrow(/append-only/);
    // ...and a failing maintenance transaction leaves nothing enabled either.
    await expect(withAuditMaintenance(db, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(db.auditEvent.deleteMany({ where: { workflowId: id } })).rejects.toThrow(/append-only/);
  });

  it("account deletion RETAINS audit events (redacting their metadata) and erases personal data", async () => {
    const user = await makeUser("f7e");
    const { id } = await makeWorkflow(user.id);
    const events = await db.auditEvent.count({ where: { userId: user.id } });
    await deleteAccount(db, user.id, NOW);
    expect(await db.auditEvent.count({ where: { userId: user.id } })).toBe(events + 1); // + ACCOUNT_DELETED
    for (const e of await db.auditEvent.findMany({ where: { userId: user.id } })) {
      expect(JSON.stringify(e.metadata ?? {})).not.toMatch(/roofing|King Street|ABC/);
    }
    const w = await db.workflow.findUniqueOrThrow({ where: { id }, include: { input: true, extracted: true } });
    expect(w.customerName).toBeNull();
    expect(w.input?.content).toBe("[deleted]");
    expect(w.extracted).toBeNull();
    const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.email).toMatch(/^deleted-.*@deleted\.invalid$/);
    expect(u.deletedAt).not.toBeNull();
  });

  it("retention purge erases documents and extracted data of finished workflows but keeps status history and audit", async () => {
    const user = await makeUser("f7f");
    const { id } = await makeWorkflow(user.id);
    const { approveCurrent } = await import("./helpers");
    const { testDeps } = await import("./helpers");
    await approveCurrent(testDeps(), id, user.id);
    const auditBefore = await db.auditEvent.count({ where: { workflowId: id } });
    expect((await purgeExpiredContent(db, { retentionDays: 90, now: NOW })).purged).toBe(0); // too recent
    const future = new Date(Date.now() + 200 * 86_400_000);
    expect((await purgeExpiredContent(db, { retentionDays: 90, now: future })).purged).toBeGreaterThanOrEqual(1);
    const w = await db.workflow.findUniqueOrThrow({ where: { id }, include: { input: true, extracted: true, actions: true, reviews: true } });
    expect(w.status).toBe("COMPLETED");
    expect(w.input?.content).toBe("[purged]");
    expect(w.extracted).toBeNull();
    expect(w.actions[0]?.output).toBeNull();
    expect(w.reviews[0]?.approvedFields).toBeNull();
    expect(await db.auditEvent.count({ where: { workflowId: id } })).toBe(auditBefore + 1);
    expect((await purgeExpiredContent(db, { retentionDays: 0, now: future })).purged).toBe(0); // 0 disables
  });
});
