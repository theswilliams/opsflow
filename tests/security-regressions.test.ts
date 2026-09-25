/**
 * Cross-cutting regression tests. The issue-specific suites (webhook.test.ts F1/F2, jobs-recovery F3,
 * approval-version F4, action-outbox F5, budget-limits F6, db-integrity F7/F8, evidence F9, duplicates F10, pdf F11)
 * hold the detailed cases; this file keeps the remaining "hostile input is inert" guards.
 */
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { redact } from "@/lib/logger";
import { DELIVERY_TEXT, makeUser, makeWorkflow } from "./helpers";

const db = getDb();

describe("hostile content is inert", () => {
  it("HTML/script in a document is stored verbatim as text and never altered or executed server-side", async () => {
    const user = await makeUser("xss");
    const evil = `Customer: <img src=x onerror=alert(1)>\n2 pallets of brick to 10 Main Street, Toronto, Ontario on 2030-01-15 at 9am. Call <script>alert(1)</script> Sam 519-555-0100`;
    const { id } = await makeWorkflow(user.id, evil);
    const input = await db.workflowInput.findUniqueOrThrow({ where: { workflowId: id } });
    expect(input.content).toContain("<img src=x onerror=alert(1)>");
  });

  it("no component uses dangerouslySetInnerHTML or eval-like sinks", () => {
    const out = execSync('git grep -nE "dangerouslySetInnerHTML|\\beval\\(|new Function\\(" -- src || true', { encoding: "utf8" });
    expect(out.trim()).toBe("");
  });

  it("the ordinary demo request still processes to a reviewable state (sanity for the hardened pipeline)", async () => {
    const user = await makeUser("sane");
    expect((await makeWorkflow(user.id, DELIVERY_TEXT)).workflow.status).toBe("REVIEW_REQUIRED");
  });

  it("logs never carry documents, secrets or contact data", () => {
    const out = JSON.stringify(redact({ text: DELIVERY_TEXT, signature: "sha256=abc", email: "a@b.test", nested: { apiKey: "sk-ant-1", address: "125 King", workflowId: "wf_1" } }));
    expect(out).not.toMatch(/King Street|sha256=abc|a@b\.test|sk-ant/);
    expect(out).toContain("wf_1");
  });

  it("job error text stored for operators never reaches the user-facing workflow fields", async () => {
    const user = await makeUser("leak");
    const { testDeps } = await import("./helpers");
    const boom = testDeps({ ai: { name: "mock", isMock: true, extract: async () => Promise.reject(new Error("password=hunter2 at /srv/app/x.ts:9")) }, maxJobAttempts: 1 });
    const { id, workflow } = await makeWorkflow(user.id, DELIVERY_TEXT, boom);
    expect(workflow.status).toBe("FAILED");
    const visible = JSON.stringify([workflow, await db.auditEvent.findMany({ where: { workflowId: id } })]);
    expect(visible).not.toMatch(/hunter2|\/srv\/app/);
  });
});
