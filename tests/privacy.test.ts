/**
 * Data-subject controls and second-audit cross-tenant checks for the tables added by the remediation.
 */
import { describe, expect, it } from "vitest";
import { authenticate } from "@/lib/auth/service";
import { getDb } from "@/lib/db";
import { deleteAccount, exportUserData } from "@/lib/privacy";
import { aiUsageOverview, recentNotifications } from "@/lib/workflow/queries";
import { createCredential } from "@/lib/webhook/credentials";
import { handleWorkflowPost, resetWebhookLimiters } from "@/lib/webhook/handler";
import { signPayload } from "@/lib/webhook/signature";
import { registerUser } from "@/lib/auth/service";
import { createSession, findSessionUser } from "@/lib/auth/service";
import { DELIVERY_TEXT, makeUser, makeWorkflow, NOW, testDeps } from "./helpers";

const db = getDb();

describe("export", () => {
  it("contains the user's own data only, and never secrets", async () => {
    const [me, other] = [await makeUser("exp"), await makeUser("exp-other")];
    const mine = await makeWorkflow(me.id);
    await makeWorkflow(other.id, `${DELIVERY_TEXT}\nOther tenant's secret request`);
    const cred = await createCredential(db, me.id, "n8n");
    const data = await exportUserData(db, me.id, NOW);
    expect(data.user.email).toBe(me.email);
    expect(data.workflows.map((w) => w.id)).toEqual([mine.id]);
    const blob = JSON.stringify(data);
    expect(blob).not.toMatch(/Other tenant's secret request/);
    expect(blob).not.toContain(other.email);
    expect(blob).not.toContain(cred.secret);
    expect(blob).not.toMatch(/passwordHash|encryptedSecret|rawBytes/);
    expect(data.credentials).toEqual([expect.objectContaining({ keyId: cred.keyId })]);
    expect(data.workflows[0]?.input?.content).toContain("roofing shingles"); // the user's own documents ARE included
    expect(data.aiUsage.length).toBeGreaterThan(0);
    expect(data.notifications.length).toBeGreaterThan(0);
    expect(data.auditEvents.length).toBeGreaterThan(0);
  });

  it("the export itself is audited", async () => {
    const me = await makeUser("exp2");
    await exportUserData(db, me.id);
    expect(await db.auditEvent.count({ where: { userId: me.id, eventType: "DATA_EXPORTED" } })).toBe(1);
  });
});

describe("account deletion", () => {
  it("revokes sign-in and API access, cancels in-flight work, erases content, and leaves other tenants untouched", async () => {
    const reg = await registerUser(db, { name: "Del", email: `del-${Date.now()}@example.test`, password: "correct horse battery" });
    const cred = await createCredential(db, reg.id, "n8n");
    const { token } = await createSession(db, reg.id);
    const pending = (await import("@/lib/workflow/service")).createWorkflow;
    const queued = await pending(testDeps(), { userId: reg.id, actor: { type: "USER", id: reg.id }, source: "PASTE", kind: "text", text: DELIVERY_TEXT }); // never processed
    const done = await makeWorkflow(reg.id, `${DELIVERY_TEXT}\nRef done`);
    const bystander = await makeUser("bystander");
    const bystanderWf = await makeWorkflow(bystander.id, `${DELIVERY_TEXT}\nRef bystander`);

    expect(await findSessionUser(db, token)).not.toBeNull();
    await deleteAccount(db, reg.id, NOW);

    // sign-in
    expect(await findSessionUser(db, token)).toBeNull();
    expect(await authenticate(db, reg.email, "correct horse battery")).toBeNull();
    expect(await authenticate(db, `deleted-${reg.id}@deleted.invalid`, "!")).toBeNull();
    // API access
    resetWebhookLimiters();
    const raw = JSON.stringify({ type: "delivery_request", text: DELIVERY_TEXT });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await handleWorkflowPost(
      new Request("http://x/api/webhooks/workflow", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-opsflow-key-id": cred.keyId, "x-opsflow-timestamp": ts, "x-opsflow-signature": signPayload(cred.secret, ts, raw) } }),
      () => testDeps(),
    );
    expect(res.status).toBe(401);
    // in-flight work is cancelled, never processed after deletion
    expect((await db.workflow.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("FAILED");
    expect((await db.job.findFirstOrThrow({ where: { workflowId: queued.id } })).status).toBe("FAILED");
    // content is gone
    const w = await db.workflow.findUniqueOrThrow({ where: { id: done.id }, include: { input: true, extracted: true, actions: true } });
    expect(w.customerName).toBeNull();
    expect(w.input?.content).toBe("[deleted]");
    expect(w.extracted).toBeNull();
    expect(await db.apiCredential.count({ where: { userId: reg.id } })).toBe(0);
    expect(await db.notification.count({ where: { userId: reg.id } })).toBe(0);
    // idempotent
    await deleteAccount(db, reg.id, NOW);
    // bystander unaffected
    const b = await db.workflow.findUniqueOrThrow({ where: { id: bystanderWf.id }, include: { input: true, extracted: true } });
    expect(b.customerName).toBe("ABC Building Supplies");
    expect(b.input?.content).toContain("Ref bystander");
    expect(b.extracted).not.toBeNull();
  });
});

describe("new tables are tenant-scoped", () => {
  it("notifications and AI usage views never include another tenant's rows", async () => {
    const [a, b] = [await makeUser("iso-a"), await makeUser("iso-b")];
    await makeWorkflow(a.id, `${DELIVERY_TEXT}\nRef A only`);
    await makeWorkflow(b.id, `${DELIVERY_TEXT}\nRef B only`);
    const notes = await recentNotifications(db, a.id, 50);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.userId === a.id)).toBe(true);
    const usage = await aiUsageOverview(db, a.id, NOW, 14);
    expect([...usage.rows, ...usage.recent].every((r) => r.userId === a.id)).toBe(true);
  });

  it("a workflow, its jobs and receipts cannot be attached to another tenant (composite FKs)", async () => {
    const [a, b] = [await makeUser("fk-a"), await makeUser("fk-b")];
    const wf = await makeWorkflow(a.id);
    await expect(db.aiUsage.create({ data: { userId: b.id, workflowId: wf.id, provider: "x", model: "x", ok: true } })).rejects.toThrow();
    await expect(db.webhookReceipt.create({ data: { userId: b.id, credentialId: "c", signatureHash: "h", contentHash: "c", workflowId: wf.id } })).rejects.toThrow();
  });
});

describe("hostile webhook JSON", () => {
  it("prototype-pollution shaped bodies and deep nesting are rejected cleanly", async () => {
    const user = await makeUser("proto");
    const cred = await createCredential(db, user.id, "t");
    resetWebhookLimiters();
    const send = async (raw: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      return handleWorkflowPost(
        new Request("http://x/api/webhooks/workflow", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-opsflow-key-id": cred.keyId, "x-opsflow-timestamp": ts, "x-opsflow-signature": signPayload(cred.secret, ts, raw) } }),
        () => testDeps(),
      );
    };
    expect((await send('{"type":"delivery_request","text":"x","__proto__":{"admin":true}}')).status).toBe(400);
    expect((await send('{"type":"delivery_request","text":"x","constructor":{"prototype":{"x":1}}}')).status).toBe(400);
    expect((await send("[".repeat(5000) + "]".repeat(5000))).status).toBe(400);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(await db.workflow.count({ where: { userId: user.id } })).toBe(0);
  });
});
