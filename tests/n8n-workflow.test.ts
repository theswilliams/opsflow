import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createCredential } from "@/lib/webhook/credentials";
import { handleWorkflowGet, handleWorkflowPost, limiters } from "@/lib/webhook/handler";
import { DELIVERY_TEXT, makeUser, testDeps } from "./helpers";

const root = path.resolve(__dirname, "..");
const workflowJson = JSON.parse(readFileSync(path.join(root, "n8n/opsflow-workflow.json"), "utf8"));
const nodeByName = (name: string) => workflowJson.nodes.find((n: { name: string }) => n.name === name);
const require_ = createRequire(import.meta.url);

/** Runs a Code node exactly as n8n would (minus n8n itself), with a fake $json/$env. */
function runCodeNode(name: string, ctx: { json: unknown; env: Record<string, string> }) {
  const code = nodeByName(name).parameters.jsCode as string;
  const fn = new Function("require", "$json", "$env", "$execution", `"use strict"; ${code}`);
  return fn(require_, ctx.json, ctx.env, { id: "exec-42" }).json as Record<string, string>;
}

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
});

describe("n8n signing code is compatible with the real webhook", async () => {
  const user = await makeUser("n8n");
  const cred = await createCredential(getDb(), user.id, "n8n test");
  const env = { OPSFLOW_SECRET: cred.secret, OPSFLOW_KEY_ID: cred.keyId };

  it("a request built by the 'Sign request' node is accepted", async () => {
    limiters.key.reset();
    limiters.ip.reset();
    const out = runCodeNode("Sign request", { json: { body: { text: DELIVERY_TEXT, external_id: "n8n-1" } }, env });
    const res = await handleWorkflowPost(
      new Request("http://localhost/api/webhooks/workflow", {
        method: "POST",
        body: out.body,
        headers: { "content-type": "application/json", "x-opsflow-key-id": out.keyId!, "x-opsflow-timestamp": out.timestamp!, "x-opsflow-signature": out.signature! },
      }),
      () => testDeps(),
    );
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
});
