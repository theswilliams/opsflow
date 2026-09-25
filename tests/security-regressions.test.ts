/**
 * Regression tests for issues found during the security review. Each test names the attack it prevents.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createCredential } from "@/lib/webhook/credentials";
import { handleWorkflowPost, limiters } from "@/lib/webhook/handler";
import { signPayload } from "@/lib/webhook/signature";
import { DELIVERY_TEXT, makeUser, makeWorkflow, testDeps } from "./helpers";

const db = getDb();
const now = () => String(Math.floor(Date.now() / 1000));

function signed(cred: { keyId: string; secret: string }, body: object, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const ts = now();
  return new Request("http://localhost/api/webhooks/workflow", {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "x-opsflow-key-id": cred.keyId, "x-opsflow-timestamp": ts, "x-opsflow-signature": signPayload(cred.secret, ts, raw), ...headers },
  });
}

beforeEach(() => Object.values(limiters).forEach((l) => l.reset()));
afterEach(() => {
  delete process.env.TRUST_PROXY;
});

describe("replay of a captured webhook request", () => {
  it("returns the original workflow instead of creating a duplicate (no idempotency key supplied)", async () => {
    const user = await makeUser("replay");
    const cred = await createCredential(db, user.id, "t");
    const body = { type: "delivery_request", text: DELIVERY_TEXT };
    const captured = signed(cred, body);
    const replay = captured.clone();

    const first = await handleWorkflowPost(captured, () => testDeps());
    const second = await handleWorkflowPost(replay, () => testDeps());
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);
    expect(await db.workflow.count({ where: { userId: user.id } })).toBe(1);
  });

  it("a freshly signed identical body is a new request (legitimate resubmission)", async () => {
    const user = await makeUser("resubmit");
    const cred = await createCredential(db, user.id, "t");
    const body = { type: "delivery_request", text: DELIVERY_TEXT };
    expect((await handleWorkflowPost(signed(cred, body, { "x-opsflow-timestamp": now() }), () => testDeps())).status).toBe(201);
    // A different timestamp yields a different signature, hence a different implicit key.
    const later = String(Math.floor(Date.now() / 1000) + 5);
    const raw = JSON.stringify(body);
    const req = new Request("http://localhost/x", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "x-opsflow-key-id": cred.keyId, "x-opsflow-timestamp": later, "x-opsflow-signature": signPayload(cred.secret, later, raw) },
    });
    expect((await handleWorkflowPost(req, () => testDeps())).status).toBe(201);
  });
});

describe("spoofed client-IP headers", () => {
  const anon = (ip: string) =>
    new Request("http://localhost/api/webhooks/workflow", { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-forwarded-for": ip } });

  it("cannot be used to dodge the per-IP rate limit when no trusted proxy is configured", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 125; i++) codes.push((await handleWorkflowPost(anon(`198.51.100.${i}`), () => testDeps())).status);
    expect(codes.slice(-3)).toEqual([429, 429, 429]);
  });

  it("is honoured only when TRUST_PROXY=true", async () => {
    process.env.TRUST_PROXY = "true";
    const codes: number[] = [];
    for (let i = 0; i < 125; i++) codes.push((await handleWorkflowPost(anon(`198.51.100.${i}`), () => testDeps())).status);
    expect(codes.every((c) => c === 401)).toBe(true);
  });
});

describe("audit trail tampering", () => {
  it("the database refuses to modify an audit event", async () => {
    const user = await makeUser("audit");
    const { id } = await makeWorkflow(user.id);
    const event = await db.auditEvent.findFirstOrThrow({ where: { workflowId: id } });
    await expect(db.auditEvent.update({ where: { id: event.id }, data: { message: "nothing to see here" } })).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.updateMany({ where: { workflowId: id }, data: { message: "x" } })).rejects.toThrow(/append-only/);
    expect((await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).message).toBe(event.message);
  });

  it("new events can still be appended", async () => {
    const user = await makeUser("audit2");
    const { id } = await makeWorkflow(user.id);
    await db.auditEvent.create({ data: { workflowId: id, userId: user.id, actorType: "SYSTEM", eventType: "NOTE", message: "ok" } });
  });
});

describe("hostile content is inert", () => {
  it("HTML/script in a document is stored verbatim as text and never altered or executed server-side", async () => {
    const user = await makeUser("xss");
    const evil = `Customer: <img src=x onerror=alert(1)>\n2 pallets of brick to 10 Main Street, Toronto, Ontario on 2030-01-15 at 9am. Call <script>alert(1)</script> Sam 519-555-0100`;
    const { id } = await makeWorkflow(user.id, evil);
    const input = await db.workflowInput.findUniqueOrThrow({ where: { workflowId: id } });
    expect(input.content).toContain("<img src=x onerror=alert(1)>");
    // Rendering safety comes from React escaping; a source-level check keeps it that way.
  });

  it("no component uses dangerouslySetInnerHTML", async () => {
    const { execSync } = await import("node:child_process");
    const out = execSync('git grep -n "dangerouslySetInnerHTML" -- src || true', { encoding: "utf8" });
    expect(out.trim()).toBe("");
  });
});
