import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { seedDemo } from "@/lib/demo/seed";
import { NOW } from "./helpers";

const db = getDb();

describe("demo seed", () => {
  it("produces one workflow per demo scenario through the real pipeline, and is repeatable", async () => {
    const run = () => seedDemo(db, { password: "demo-password-for-tests", now: NOW, withCredential: true });
    const first = await run();
    const statuses = async (ids: Record<string, string>) =>
      Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, (await db.workflow.findUniqueOrThrow({ where: { id } })).status])));

    expect(await statuses(first.workflowIds)).toEqual({
      completed: "COMPLETED",
      failed: "FAILED",
      rejected: "REJECTED",
      review: "REVIEW_REQUIRED",
      missing: "REVIEW_REQUIRED",
      lowConfidence: "REVIEW_REQUIRED",
      edited: "REVIEW_REQUIRED",
    });
    expect(first.credential?.secret).toMatch(/^ofs_/);

    const missing = await db.validationResult.findFirstOrThrow({ where: { workflowId: first.workflowIds.missing! } });
    expect(missing.passed).toBe(false);
    const low = await db.workflow.findUniqueOrThrow({ where: { id: first.workflowIds.lowConfidence! } });
    expect(["LOW", "UNKNOWN"]).toContain(low.overallConfidence);
    const failed = await db.workflow.findUniqueOrThrow({ where: { id: first.workflowIds.failed! } });
    expect(failed.failureReason).toMatch(/simulated outage/);

    const second = await run();
    expect(second.userId).toBe(first.userId);
    expect(await db.workflow.count({ where: { userId: first.userId } })).toBe(7);
  });
});
