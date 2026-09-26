import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createCredential } from "@/lib/webhook/credentials";
import { handleWorkflowGet, handleWorkflowPost, resetWebhookLimiters } from "@/lib/webhook/handler";
import { DELIVERY_TEXT, makeUser, testDeps } from "./helpers";

const root = path.resolve(__dirname, "..");
const workflowJson = JSON.parse(readFileSync(path.join(root, "n8n/opsflow-workflow.json"), "utf8"));
const nodeByName = (name: string) => workflowJson.nodes.find((n: { name: string }) => n.name === name);
const require_ = createRequire(import.meta.url);

/** Runs a Code node exactly as n8n would (minus n8n itself), with a fake $json/$env/$execution. */
function runCodeNode(name: string, ctx: { json: unknown; env: Record<string, string>; executionId?: string }) {
  const code = nodeByName(name).parameters.jsCode as string;
  const fn = new Function("require", "$json", "$env", "$execution", `"use strict"; ${code}`);
  return fn(require_, ctx.json, ctx.env, { id: ctx.executionId ?? "exec-42" }).json as Record<string, string>;
}

beforeEach(() => resetWebhookLimiters());

describe("n8n workflow definition", () => {
  it("is valid: every connection references an existing node and every node is reachable", () => {
    const names = new Set(workflowJson.nodes.map((n: { name: string }) => n.name));
    for (const [from, outputs] of Object.entries(workflowJson.connections as Record<string, { main: { node: string }[][] }>)) {
      expect(names.has(from), from).toBe(true);
      for (const group of outputs.main) for (const l of group) expect(names.has(l.node), l.node).toBe(true);
    }
    const reachable = new Set<string>(["Incoming Request"]);
    for (let i = 0; i < 20; i++) {
      for (const [from, outputs] of Object.entries(workflowJson.connections as Record<string, { main: { node: string }[][] }>)) {
        if (reachable.has(from)) outputs.main.flat().forEach((l) => reachable.add(l.node));
      }
    }
    const actionable = workflowJson.nodes.filter((n: { type: string }) => !n.type.endsWith("stickyNote")).map((n: { name: string }) => n.name);
    for (const n of actionable) expect(reachable.has(n), n).toBe(true);
  });

  it("contains no credentials or secrets", () => {
    const text = JSON.stringify(workflowJson);
    expect(text).not.toMatch(/ofs_[A-Za-z0-9_-]{10,}/);
    expect(text).not.toMatch(/"credentials"/);
    expect(text).toContain("$env.OPSFLOW_SECRET");
  });

  it("no longer derives the external id from $execution.id (which changed on every trigger)", () => {
    expect(nodeByName("Sign request").parameters.jsCode).not.toContain("$execution");
  });
});

describe("n8n signing code is compatible with the real webhook", async () => {
  const user = await makeUser("n8n");
  const cred = await createCredential(getDb(), user.id, "n8n test");
  const env = { OPSFLOW_SECRET: cred.secret, OPSFLOW_KEY_ID: cred.keyId };

  const send = (out: Record<string, string>) =>
    handleWorkflowPost(
      new Request("http://localhost/api/webhooks/workflow", {
        method: "POST",
        body: out.body,
        headers: { "content-type": "application/json", "x-opsflow-key-id": out.keyId!, "x-opsflow-timestamp": out.timestamp!, "x-opsflow-signature": out.signature! },
      }),
      () => testDeps(),
    );

  it("a request built by the 'Sign request' node is accepted; the status poll built by 'Sign status request' works", async () => {
    const out = runCodeNode("Sign request", { json: { body: { text: `${DELIVERY_TEXT}\nRef n8n-1`, external_id: "n8n-1" } }, env });
    const res = await send(out);
    expect(res.status).toBe(201);
    const created = await res.json();

    const st = runCodeNode("Sign status request", { json: {}, env });
    const status = await handleWorkflowGet(
      new Request(`http://localhost/api/webhooks/workflow/${created.id}`, {
        headers: { "x-opsflow-key-id": st.keyId!, "x-opsflow-timestamp": st.timestamp!, "x-opsflow-signature": st.signature! },
      }),
      created.id,
      () => testDeps(),
    );
    expect(status.status).toBe(200);
    expect((await status.json()).status).toBe("REVIEW_REQUIRED");
  });

  it("a REPEATED upstream trigger (new execution id, new timestamp, same message) does not create a second workflow", async () => {
    const message = { text: `${DELIVERY_TEXT}\nRef repeated-trigger` };
    const a = await send(runCodeNode("Sign request", { json: { body: message }, env, executionId: "exec-1" }));
    const b = await send(runCodeNode("Sign request", { json: { body: message }, env, executionId: "exec-2" }));
    expect([a.status, b.status]).toEqual([201, 200]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(jb).toMatchObject({ id: ja.id, duplicate: true });
    expect(await getDb().workflow.count({ where: { userId: user.id, source: "WEBHOOK", input: { is: { content: { contains: "Ref repeated-trigger" } } } } })).toBe(1);
  });

  it("the upstream's own id (e.g. an email Message-ID) is the idempotency key when supplied", async () => {
    const first = await send(runCodeNode("Sign request", { json: { body: { text: `${DELIVERY_TEXT}\nRef mid`, message_id: "<abc@mail>" } }, env }));
    const again = await send(runCodeNode("Sign request", { json: { body: { text: `${DELIVERY_TEXT}\nRef mid`, message_id: "<abc@mail>" } }, env }));
    // "<abc@mail>" contains characters outside the allowed key alphabet → rejected early rather than creating anything
    expect(first.status).toBe(400);
    expect(again.status).toBe(400);
    const ok1 = await send(runCodeNode("Sign request", { json: { body: { text: `${DELIVERY_TEXT}\nRef mid2`, message_id: "abc-123@mail" } }, env }));
    const ok2 = await send(runCodeNode("Sign request", { json: { body: { text: `${DELIVERY_TEXT}\nRef mid2`, message_id: "abc-123@mail" } }, env }));
    expect([ok1.status, ok2.status]).toEqual([201, 200]);
  });
});
