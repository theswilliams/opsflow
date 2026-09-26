/**
 * F10 — duplicate detection: deterministic normalisation + an indexed lookup with no row cap.
 */
import { describe, expect, it } from "vitest";
import type { ExtractedFields } from "@/lib/ai/schema";
import { getDb } from "@/lib/db";
import { duplicateKeys, findDuplicates } from "@/lib/workflow/core";
import { normalizeAddress, normalizeCustomer } from "@/lib/validation/normalize";
import { DELIVERY_TEXT, makeUser, makeWorkflow } from "./helpers";

const db = getDb();
const codesOf = async (workflowId: string) =>
  ((await db.validationResult.findFirstOrThrow({ where: { workflowId }, orderBy: { createdAt: "desc" } })).issues as { code: string }[]).map((i) => i.code);

describe("customer normalisation", () => {
  it.each([
    ["ABC Building Supplies", "abc building supplies"],
    ["ABC Building Supplies Ltd", "abc building supplies"],
    ["ABC Building Supplies Ltd.", "abc building supplies"],
    ["ABC Building Supplies, Inc.", "abc building supplies"],
    ["A.B.C. Building Supplies Corp", "abc building supplies"],
    ["  abc   BUILDING\tsupplies  ", "abc building supplies"],
    ["The ABC Building Supplies Company", "abc building supplies"],
    ["ABC Building Supplies Limited", "abc building supplies"],
    ["ABC Building Supplies LLC", "abc building supplies"],
    ["Smith & Sons Ltd", "smith and sons"],
    ["Smith and Sons", "smith and sons"],
    ["Café Ébène Inc", "cafe ebene"],
    ["ＡＢＣ Building Supplies", "abc building supplies"], // full-width Unicode
  ])("%s → %s", (input, key) => expect(normalizeCustomer(input)).toBe(key));

  it("does not merge genuinely different businesses", () => {
    const keys = ["ABC Building Supplies", "ABC Building Supply", "ABC Building Supplies East", "ABD Building Supplies", "Building Supplies", "ABC Roofing"].map(normalizeCustomer);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never reduces a name to nothing", () => {
    expect(normalizeCustomer("Inc")).toBe("inc");
    expect(normalizeCustomer("Ltd.")).toBe("ltd");
    expect(normalizeCustomer("")).toBe("");
  });
});

describe("address normalisation", () => {
  it.each([
    ["125 King Street, London, Ontario", "125 king st london on"],
    ["125 King St London ON", "125 king st london on"],
    ["125 KING STREET,  LONDON,  Ontario.", "125 king st london on"],
    ["77 Oak Avenue, Toronto, Ontario", "77 oak ave toronto on"],
    ["77 Oak Ave., Toronto, ON", "77 oak ave toronto on"],
    ["1 Main Street North, Kitchener, ON", "1 main st n kitchener on"],
    ["1 Main St. N, Kitchener, ON", "1 main st n kitchener on"],
  ])("%s", (input, key) => expect(normalizeAddress(input)).toBe(key));

  it("keeps different addresses different", () => {
    expect(normalizeAddress("125 King Street, London, ON")).not.toBe(normalizeAddress("126 King Street, London, ON"));
    expect(normalizeAddress("125 King Street, London, ON")).not.toBe(normalizeAddress("125 Queen Street, London, ON"));
  });
});

describe("F10 · duplicate detection end to end", () => {
  const variant = (name: string) => DELIVERY_TEXT.replace("ABC Building Supplies", name);

  it.each(["ABC Building Supplies", "abc building supplies", "ABC Building Supplies Ltd", "ABC Building Supplies Ltd.", "ABC Building Supplies, Inc.", "A.B.C. Building  Supplies Corp"])(
    "%s duplicates an existing 'ABC Building Supplies' order (same address and date)",
    async (name) => {
      const user = await makeUser("f10a");
      const first = await makeWorkflow(user.id);
      const second = await makeWorkflow(user.id, variant(name));
      expect(await codesOf(second.id)).toContain("DUPLICATE_SUSPECTED");
      expect(await codesOf(first.id)).not.toContain("DUPLICATE_SUSPECTED"); // the earlier one predates the later
    },
  );

  it("address variants (St/Street, ON/Ontario) still match", async () => {
    const user = await makeUser("f10b");
    await makeWorkflow(user.id);
    const second = await makeWorkflow(user.id, DELIVERY_TEXT.replace("125 King Street, London Ontario", "125 King St., London, ON"));
    expect(await codesOf(second.id)).toContain("DUPLICATE_SUSPECTED");
  });

  it("does NOT flag unrelated businesses, different addresses, different dates, other tenants, or rejected/failed orders", async () => {
    const user = await makeUser("f10c");
    const other = await makeUser("f10d");
    await makeWorkflow(user.id);
    const results = [
      await makeWorkflow(user.id, variant("ABC Roofing")), // different customer
      await makeWorkflow(user.id, variant("ABC Building Supply Co-op")), // similar, different business
      await makeWorkflow(user.id, DELIVERY_TEXT.replace("125 King", "999 Queen")), // different address
      await makeWorkflow(user.id, DELIVERY_TEXT.replace("this Friday", "on 2026-10-09")), // different date
      await makeWorkflow(other.id), // someone else's identical request
    ];
    for (const r of results) expect(await codesOf(r.id), r.id).not.toContain("DUPLICATE_SUSPECTED");

    // a rejected original no longer counts
    const { rejectWorkflow } = await import("@/lib/workflow/service");
    const u2 = await makeUser("f10e");
    const orig = await makeWorkflow(u2.id);
    await rejectWorkflow((await import("./helpers")).testDeps(), { workflowId: orig.id, userId: u2.id, actor: { type: "USER", id: u2.id } });
    expect(await codesOf((await makeWorkflow(u2.id)).id)).not.toContain("DUPLICATE_SUSPECTED");
  });

  it("an edit that makes two requests identical is detected, and one that separates them clears the warning", async () => {
    const user = await makeUser("f10f");
    await makeWorkflow(user.id);
    const other = await makeWorkflow(user.id, variant("Zeta Supply"));
    expect(await codesOf(other.id)).not.toContain("DUPLICATE_SUSPECTED");
    const { editCurrent } = await import("./helpers");
    const { testDeps } = await import("./helpers");
    await editCurrent(testDeps(), other.id, user.id, { customer: "ABC Building Supplies Inc" });
    expect(await codesOf(other.id)).toContain("DUPLICATE_SUSPECTED");
    await editCurrent(testDeps(), other.id, user.id, { customer: "Zeta Supply" });
    expect(await codesOf(other.id)).not.toContain("DUPLICATE_SUSPECTED");
  });
});

describe("F10 · large data sets (no 25-row cap, deterministic)", () => {
  const fields = (customer: string, date: string): ExtractedFields => ({
    customer,
    address: "125 King Street, London, Ontario",
    requested_date: date,
    requested_time_window: null,
    requested_time_start: null,
    requested_time_end: null,
    items: [],
    contact_name: null,
    contact_phone: null,
    special_instructions: null,
  });

  it("finds the match even when the customer has hundreds of other orders (the original bug hid it beyond row 25)", async () => {
    const user = await makeUser("f10big");
    const k = (c: string, d: string) => duplicateKeys(fields(c, d));
    // 400 orders for the same frequent customer on different days, plus 400 for other customers.
    const rows = [];
    for (let i = 0; i < 400; i++) {
      const d = new Date(Date.UTC(2027, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      rows.push({ userId: user.id, type: "DELIVERY_REQUEST" as const, source: "PASTE" as const, status: "REVIEW_REQUIRED" as const, ...k("ABC Building Supplies Ltd", d), createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000) });
      rows.push({ userId: user.id, type: "DELIVERY_REQUEST" as const, source: "PASTE" as const, status: "REVIEW_REQUIRED" as const, ...k(`Other Customer ${i}`, d) });
    }
    await db.workflow.createMany({ data: rows });
    // The oldest ABC order (2027-01-01) is ~400 rows deep in creation order.
    const probe = await makeWorkflow(user.id, "Customer: ABC Building Supplies\nDeliver 4 pallets of roofing shingles to 125 King Street, London, Ontario on 2027-01-01 at 9am. Call Mike 519-555-0100.");
    // (2027-01-01 is a Friday; a real request for it is valid in the future relative to the fixed test clock.)
    expect(await codesOf(probe.id)).toContain("DUPLICATE_SUSPECTED");

    const found = await findDuplicates(db, user.id, probe.id, fields("ABC Building Supplies", "2027-01-01"));
    expect(found).toHaveLength(1);
    // A date that only appears once among the 400 still resolves directly through the index.
    const other = await findDuplicates(db, user.id, "none", fields("abc building supplies inc.", "2027-06-30"));
    expect(other).toHaveLength(1);
    expect(await findDuplicates(db, user.id, "none", fields("ABC Building Supplies", "2031-01-01"))).toEqual([]);
  });

  it("results are deterministic: newest first, id as tie-break, capped only for display", async () => {
    const user = await makeUser("f10det");
    const keys = duplicateKeys(fields("Repeat Customer Ltd", "2027-03-03"));
    await db.workflow.createMany({
      data: Array.from({ length: 15 }, (_, i) => ({ userId: user.id, type: "DELIVERY_REQUEST" as const, source: "PASTE" as const, status: "REVIEW_REQUIRED" as const, ...keys, createdAt: new Date(Date.UTC(2026, 5, 1, 0, i)) })),
    });
    const a = await findDuplicates(db, user.id, "x", fields("Repeat Customer", "2027-03-03"));
    const b = await findDuplicates(db, user.id, "x", fields("REPEAT CUSTOMER INC", "2027-03-03"));
    expect(a).toHaveLength(10);
    expect(a).toEqual(b);
    const newest = await db.workflow.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    expect(a[0]?.id).toBe(newest.id);
  });

  it("the lookup is served by the composite index (no sequential scan of the whole table)", async () => {
    const user = await makeUser("f10idx");
    const keys = duplicateKeys(fields("Index Customer", "2027-04-04"));
    await db.workflow.createMany({
      data: Array.from({ length: 300 }, (_, i) => ({ userId: user.id, type: "DELIVERY_REQUEST" as const, source: "PASTE" as const, status: "REVIEW_REQUIRED" as const, ...duplicateKeys(fields(`Filler ${i}`, "2027-04-04")) })),
    });
    await db.workflow.create({ data: { userId: user.id, type: "DELIVERY_REQUEST", source: "PASTE", status: "REVIEW_REQUIRED", ...keys } });
    await db.$executeRawUnsafe(`ANALYZE "Workflow"`);
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`); // proves an index path EXISTS for this predicate
      return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT id FROM "Workflow" WHERE "userId" = '${user.id}' AND "customerKey" = '${keys.customerKey}' AND "deliveryDate" = '2027-04-04'`,
      );
    });
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/Workflow_userId_customerKey_deliveryDate_idx/);
  });
});
