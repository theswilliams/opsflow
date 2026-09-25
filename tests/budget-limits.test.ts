/**
 * F6 — credential multiplication and unbounded AI spend.
 */
import { describe, expect, it } from "vitest";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import type { AIProvider } from "@/lib/ai/provider";
import { extractDeliveryRequest } from "@/lib/ai/mock-provider";
import { estimateCostMicroUsd, usageSummary } from "@/lib/ai/usage";
import { getDb } from "@/lib/db";
import { parseEnv } from "@/lib/env";
import { createCredential } from "@/lib/webhook/credentials";
import { appLimiters, resetAppLimiters } from "@/lib/rate-limits";
import { actorOf, DELIVERY_TEXT, makeUser, makeWorkflow, NOW, ScriptedProvider, TODAY, testDeps } from "./helpers";

const db = getDb();

/** A provider that reports token usage like the real API does. */
const metered = (input: number, output: number): AIProvider => ({
  name: "claude",
  isMock: false,
  extract: async (req) => ({ output: extractDeliveryRequest(req.text, req.referenceDate), model: "claude-test", usage: { inputTokens: input, outputTokens: output } }),
});

describe("F6 · credential limits", () => {
  it("a user cannot mint unlimited credentials; revoking frees a slot; races cannot exceed the cap", async () => {
    const user = await makeUser("f6a");
    for (let i = 0; i < 5; i++) await createCredential(db, user.id, `c${i}`, 5);
    await expect(createCredential(db, user.id, "one-too-many", 5)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const first = await db.apiCredential.findFirstOrThrow({ where: { userId: user.id } });
    await db.apiCredential.update({ where: { id: first.id }, data: { revokedAt: new Date() } });
    await createCredential(db, user.id, "replacement", 5);

    const racer = await makeUser("f6b");
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => createCredential(db, racer.id, `r${i}`, 5)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await db.apiCredential.count({ where: { userId: racer.id, revokedAt: null } })).toBe(5);
  });

  it("credential creation is also rate limited per user", () => {
    resetAppLimiters();
    const results = Array.from({ length: 7 }, () => appLimiters.credentialCreateByUser.check("user-x").allowed);
    expect(results).toEqual([true, true, true, true, true, false, false]);
    expect(appLimiters.credentialCreateByUser.check("user-y").allowed).toBe(true); // per user, not global
  });

  it("the cap is configurable and validated", () => {
    const base = { DATABASE_URL: "x", APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") };
    expect(parseEnv({ ...base, MAX_CREDENTIALS_PER_USER: "2" }).data?.MAX_CREDENTIALS_PER_USER).toBe(2);
    expect(parseEnv({ ...base, MAX_CREDENTIALS_PER_USER: "0" }).success).toBe(false);
    expect(parseEnv(base).data?.MAX_CREDENTIALS_PER_USER).toBe(5);
  });
});

describe("F6 · AI usage is recorded, never invented", () => {
  it("records every request with provider, model, workflow, user and timestamp; mock reports no tokens or cost", async () => {
    const user = await makeUser("f6c");
    const { id } = await makeWorkflow(user.id);
    const rows = await db.aiUsage.findMany({ where: { workflowId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: user.id, provider: "mock", model: "mock-rules-v1", ok: true, inputTokens: null, outputTokens: null, costMicroUsd: null });
    expect(rows[0]!.createdAt).toEqual(NOW);
  });

  it("records token usage and estimates cost only when prices are configured", async () => {
    const user = await makeUser("f6d");
    const priced = testDeps({ ai: metered(1_000, 500), prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
    const { id } = await makeWorkflow(user.id, DELIVERY_TEXT, priced);
    expect(await db.aiUsage.findFirstOrThrow({ where: { workflowId: id } })).toMatchObject({ provider: "claude", model: "claude-test", inputTokens: 1_000, outputTokens: 500, costMicroUsd: 1_000 * 3 + 500 * 15 });

    const unpriced = testDeps({ ai: metered(1_000, 500) });
    const b = await makeWorkflow(user.id, `${DELIVERY_TEXT}\nRef 2`, unpriced);
    expect((await db.aiUsage.findFirstOrThrow({ where: { workflowId: b.id } })).costMicroUsd).toBeNull(); // unknown, not fabricated
    expect(estimateCostMicroUsd({ inputTokens: 10, outputTokens: null }, { inputUsdPerMTok: 1, outputUsdPerMTok: 1 })).toBeNull();
  });

  it("failed and retried requests are recorded too (providers bill for them)", async () => {
    const user = await makeUser("f6e");
    const bad = testDeps({ ai: new ScriptedProvider([() => ({ output: { nope: 1 }, model: "m", usage: { inputTokens: 10, outputTokens: 1 } })]) });
    const { id } = await makeWorkflow(user.id, DELIVERY_TEXT, bad);
    const rows = await db.aiUsage.findMany({ where: { workflowId: id } });
    expect(rows).toHaveLength(2); // initial attempt + one schema-feedback retry
    const boom = testDeps({ ai: { name: "mock", isMock: true, extract: async () => Promise.reject(new Error("net")) }, maxJobAttempts: 1 });
    const c = await makeWorkflow(user.id, `${DELIVERY_TEXT}\nRef 9`, boom);
    expect((await db.aiUsage.findMany({ where: { workflowId: c.id } })).every((r) => r.ok === false)).toBe(true);
  });
});

describe("F6 · configurable budgets stop spend", () => {
  it("daily request budget: further requests are refused (no AI call), explained to the user, and other users are unaffected", async () => {
    const [user, other] = [await makeUser("f6f"), await makeUser("f6g")];
    let calls = 0;
    const counting: AIProvider = { name: "mock", isMock: true, extract: async (r) => (calls++, new MockAIProvider().extract(r)) };
    const deps = testDeps({ ai: counting, budget: { dailyRequests: 3, dailyTokens: 0, monthlyCostUsd: 0 } });
    for (let i = 0; i < 3; i++) expect((await makeWorkflow(user.id, `${DELIVERY_TEXT}\nRef ${i}`, deps)).workflow.status).toBe("REVIEW_REQUIRED");
    const blocked = await makeWorkflow(user.id, `${DELIVERY_TEXT}\nRef blocked`, deps);
    expect(blocked.workflow.status).toBe("FAILED");
    expect(blocked.workflow.failureReason).toMatch(/daily AI request limit/);
    expect(calls).toBe(3); // the 4th never reached the provider
    expect(await db.job.findUniqueOrThrow({ where: { workflowId_type: { workflowId: blocked.id, type: "PROCESS_WORKFLOW" } } })).toMatchObject({ attempts: 1 }); // terminal: no retry storm
    expect((await makeWorkflow(other.id, `${DELIVERY_TEXT}\nRef other`, deps)).workflow.status).toBe("REVIEW_REQUIRED");
  });

  it("the budget is a rolling window: old usage stops counting", async () => {
    const user = await makeUser("f6h");
    await db.aiUsage.createMany({ data: Array.from({ length: 5 }, () => ({ userId: user.id, provider: "mock", model: "m", ok: true, createdAt: new Date(NOW.getTime() - 25 * 3_600_000) })) });
    const deps = testDeps({ budget: { dailyRequests: 3, dailyTokens: 0, monthlyCostUsd: 0 } });
    expect((await usageSummary(db, user.id, NOW)).requests).toBe(0);
    expect((await makeWorkflow(user.id, DELIVERY_TEXT, deps)).workflow.status).toBe("REVIEW_REQUIRED");
  });

  it("daily token budget and monthly cost budget", async () => {
    const [t, c] = [await makeUser("f6i"), await makeUser("f6j")];
    const tokenDeps = testDeps({ ai: metered(600, 400), budget: { dailyRequests: 0, dailyTokens: 1_500, monthlyCostUsd: 0 } });
    expect((await makeWorkflow(t.id, `${DELIVERY_TEXT}\n1`, tokenDeps)).workflow.status).toBe("REVIEW_REQUIRED"); // 1000 tokens used
    expect((await makeWorkflow(t.id, `${DELIVERY_TEXT}\n2`, tokenDeps)).workflow.status).toBe("REVIEW_REQUIRED"); // 2000 (check happens before)
    expect((await makeWorkflow(t.id, `${DELIVERY_TEXT}\n3`, tokenDeps)).workflow.failureReason).toMatch(/daily AI usage limit/);

    const costDeps = testDeps({ ai: metered(1_000_000, 0), prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 }, budget: { dailyRequests: 0, dailyTokens: 0, monthlyCostUsd: 5 } });
    expect((await makeWorkflow(c.id, `${DELIVERY_TEXT}\n1`, costDeps)).workflow.status).toBe("REVIEW_REQUIRED"); // $3
    expect((await makeWorkflow(c.id, `${DELIVERY_TEXT}\n2`, costDeps)).workflow.status).toBe("REVIEW_REQUIRED"); // $6 total
    expect((await makeWorkflow(c.id, `${DELIVERY_TEXT}\n3`, costDeps)).workflow.failureReason).toMatch(/monthly AI spending limit/);
  });

  it("0 means unlimited for that ceiling; defaults are sensible and configurable", () => {
    const base = { DATABASE_URL: "x", APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") };
    const d = parseEnv(base).data!;
    expect([d.AI_DAILY_REQUEST_BUDGET, d.AI_DAILY_TOKEN_BUDGET, d.AI_MONTHLY_COST_BUDGET_USD]).toEqual([200, 400_000, 0]);
    const custom = parseEnv({ ...base, AI_DAILY_REQUEST_BUDGET: "50", AI_PRICE_INPUT_USD_PER_MTOK: "3", AI_PRICE_OUTPUT_USD_PER_MTOK: "15", AI_MONTHLY_COST_BUDGET_USD: "25" }).data!;
    expect([custom.AI_DAILY_REQUEST_BUDGET, custom.AI_PRICE_INPUT_USD_PER_MTOK, custom.AI_MONTHLY_COST_BUDGET_USD]).toEqual([50, 3, 25]);
    // an empty value in .env means "use the default", never "zero = unlimited"
    expect(parseEnv({ ...base, AI_DAILY_REQUEST_BUDGET: "" }).data!.AI_DAILY_REQUEST_BUDGET).toBe(200);
    expect(parseEnv({ ...base, AI_DAILY_REQUEST_BUDGET: "-5" }).success).toBe(false);
  });

  it("webhook-created and UI-created workflows are budgeted identically (the budget lives in the job, not the request path)", async () => {
    const user = await makeUser("f6k");
    const { createWorkflow } = await import("@/lib/workflow/service");
    const { drainJobs } = await import("@/lib/jobs/worker");
    const deps = testDeps({ budget: { dailyRequests: 2, dailyTokens: 0, monthlyCostUsd: 0 } });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await createWorkflow(deps, { userId: user.id, actor: actorOf(user.id), source: "WEBHOOK", kind: "text", text: `${DELIVERY_TEXT}\nRef ${i}` })).id);
    await drainJobs(deps);
    const statuses = await Promise.all(ids.map(async (id) => (await db.workflow.findUniqueOrThrow({ where: { id } })).status));
    expect(statuses.filter((s) => s === "REVIEW_REQUIRED")).toHaveLength(2);
    expect(statuses.filter((s) => s === "FAILED")).toHaveLength(2);
    void TODAY;
  });
});

describe("F6 · the budget cannot be overshot by concurrency (reserve-then-call)", () => {
  it("10 workflows processed at the same time against a budget of 3 requests: exactly 3 reach the provider", async () => {
    const user = await makeUser("f6conc");
    const { createWorkflow } = await import("@/lib/workflow/service");
    const { drainJobs } = await import("@/lib/jobs/worker");
    let calls = 0;
    const slow: AIProvider = {
      name: "mock",
      isMock: true,
      extract: async (req) => {
        calls++;
        await new Promise((r) => setTimeout(r, 60)); // widen the race window
        return new MockAIProvider().extract(req);
      },
    };
    const mk = (i: number) => testDeps({ ai: slow, workerId: `conc-${i}`, budget: { dailyRequests: 3, dailyTokens: 0, monthlyCostUsd: 0 } });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await createWorkflow(mk(0), { userId: user.id, actor: actorOf(user.id), source: "WEBHOOK", kind: "text", text: `${DELIVERY_TEXT}\nRef ${i}` })).id);
    await Promise.all(Array.from({ length: 10 }, (_, i) => drainJobs(mk(i), 10)));
    const statuses = await Promise.all(ids.map(async (id) => (await db.workflow.findUniqueOrThrow({ where: { id } })).status));
    expect(statuses.filter((s) => s === "REVIEW_REQUIRED")).toHaveLength(3);
    expect(statuses.filter((s) => s === "FAILED")).toHaveLength(7);
    expect(calls).toBe(3);
    expect(await db.aiUsage.count({ where: { userId: user.id } })).toBe(3);
  });
});
