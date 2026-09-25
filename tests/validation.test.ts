import { describe, expect, it } from "vitest";
import type { ExtractedFields } from "@/lib/ai/schema";
import { validateDelivery } from "@/lib/validation/delivery";
import { decideReview, overallConfidence } from "@/lib/validation/rules";
import { extractDeliveryRequest } from "@/lib/ai/mock-provider";
import { DELIVERY_TEXT, TODAY } from "./helpers";

const base = (over: Partial<ExtractedFields> = {}): ExtractedFields => ({
  customer: "ABC Building Supplies",
  address: "125 King Street, London, Ontario",
  requested_date: "2026-10-02",
  requested_time_window: "specific",
  requested_time_start: "09:00",
  requested_time_end: "11:00",
  items: [{ description: "roofing shingles", quantity: 4, unit: "pallets" }],
  contact_name: "Mike",
  contact_phone: "519-555-0142",
  special_instructions: null,
  ...over,
});
const codes = (f: ExtractedFields, dup = false) => validateDelivery(f, { today: TODAY, duplicates: dup ? [{ id: "wf_1" }] : [] }).issues.map((i) => i.code);

describe("deterministic validation", () => {
  it("passes a complete, sane request with no issues", () => {
    const r = validateDelivery(base(), { today: TODAY });
    expect(r.passed).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("requires customer, address, date and items", () => {
    const c = codes(base({ customer: null, address: null, requested_date: null, items: [] }));
    expect(c).toEqual(expect.arrayContaining(["CUSTOMER_MISSING", "ADDRESS_MISSING", "DATE_MISSING", "ITEMS_MISSING"]));
  });

  it("rejects invalid and past dates", () => {
    expect(codes(base({ requested_date: "2026-02-30" }))).toContain("DATE_INVALID");
    expect(codes(base({ requested_date: "2026-09-01" }))).toContain("DATE_IN_PAST");
    expect(codes(base({ requested_date: TODAY }))).toContain("DATE_TODAY");
    expect(codes(base({ requested_date: "2026-10-04" }))).toContain("DATE_SUNDAY");
    expect(codes(base({ requested_date: "2027-09-01" }))).toContain("DATE_FAR_FUTURE");
  });

  it("rejects invalid quantities", () => {
    expect(codes(base({ items: [{ description: "x", quantity: 0, unit: "pallets" }] }))).toContain("QUANTITY_INVALID");
    expect(codes(base({ items: [{ description: "x", quantity: -3, unit: "pallets" }] }))).toContain("QUANTITY_INVALID");
    expect(codes(base({ items: [{ description: "x", quantity: null, unit: "pallets" }] }))).toContain("QUANTITY_MISSING");
    expect(codes(base({ items: [{ description: "x", quantity: 2.5, unit: "pallets" }] }))).toContain("QUANTITY_NOT_WHOLE");
    expect(codes(base({ items: [{ description: "x", quantity: 99999, unit: "pallets" }] }))).toContain("QUANTITY_LARGE");
    expect(codes(base({ items: [{ description: "x", quantity: 2, unit: null }] }))).toContain("UNIT_MISSING");
  });

  it("rejects malformed addresses", () => {
    expect(codes(base({ address: "somewhere downtown" }))).toContain("ADDRESS_MALFORMED");
    expect(codes(base({ address: "PO Box 55, London, Ontario" }))).toContain("ADDRESS_PO_BOX");
    expect(codes(base({ address: "125 King Street" }))).toContain("ADDRESS_NO_LOCALITY");
    expect(codes(base())).not.toContain("ADDRESS_NO_LOCALITY");
  });

  it("validates time ranges", () => {
    expect(codes(base({ requested_time_start: "11:00", requested_time_end: "09:00" }))).toContain("TIME_RANGE_INVALID");
    expect(codes(base({ requested_time_start: "09:00", requested_time_end: "09:00" }))).toContain("TIME_RANGE_INVALID");
    expect(codes(base({ requested_time_start: "05:00", requested_time_end: "07:00" }))).toContain("TIME_OUTSIDE_HOURS");
    expect(codes(base({ requested_time_start: "06:00", requested_time_end: "19:00" }))).toContain("TIME_RANGE_WIDE");
    expect(codes(base({ requested_time_window: "specific", requested_time_start: null, requested_time_end: null }))).toContain("TIME_START_MISSING");
  });

  it("flags an ambiguous (general) time as a warning, not an error", () => {
    const r = validateDelivery(base({ requested_time_window: "morning", requested_time_start: null, requested_time_end: null }), { today: TODAY });
    expect(r.issues.find((i) => i.code === "TIME_NOT_SPECIFIC")?.severity).toBe("warning");
    expect(r.passed).toBe(true);
  });

  it("checks contact information", () => {
    expect(codes(base({ contact_phone: null }))).toContain("CONTACT_PHONE_MISSING");
    expect(codes(base({ contact_phone: null, contact_name: null }))).toContain("CONTACT_MISSING");
    expect(codes(base({ contact_phone: "12345" }))).toContain("PHONE_INVALID");
    expect(codes(base({ contact_phone: "+1 (519) 555-0142" }))).not.toContain("PHONE_INVALID");
  });

  it("flags suspected duplicates", () => {
    expect(codes(base(), true)).toContain("DUPLICATE_SUSPECTED");
  });

  it("rejects unsupported workflow types", () => {
    const r = validateDelivery(base(), { today: TODAY, workflowType: "WIRE_TRANSFER" });
    expect(r.issues.map((i) => i.code)).toContain("TYPE_NOT_ALLOWED");
    expect(r.passed).toBe(false);
  });

  it("does not depend on the AI: a confident-but-wrong extraction still fails", () => {
    const r = validateDelivery(base({ requested_date: "2020-01-01", items: [{ description: "x", quantity: -1, unit: "pallets" }] }), { today: TODAY });
    expect(r.passed).toBe(false);
    expect(r.errorCount).toBe(2);
  });
});

describe("business rules", () => {
  const e = extractDeliveryRequest(DELIVERY_TEXT, TODAY);
  const validation = validateDelivery(e.fields, { today: TODAY });

  it("routes the ambiguous demo request to attention with reasons", () => {
    const d = decideReview({ requiresHumanReview: e.requires_human_review, aiReason: e.reason, assessments: e.field_assessments, ambiguities: e.ambiguities, validation });
    expect(d.needsAttention).toBe(true);
    expect(d.reasons.length).toBeGreaterThan(0);
    // The time ambiguity is explained once, not again as a warning.
    expect(d.reasons.filter((r) => /morning/i.test(r))).toHaveLength(1);
  });

  it("overall confidence is the weakest required field", () => {
    expect(overallConfidence(e.field_assessments)).toBe("MEDIUM");
    const low = structuredClone(e.field_assessments);
    low.address.confidence = "low";
    expect(overallConfidence(low)).toBe("LOW");
  });

  it("a clean, fully-specified request needs no special attention", () => {
    const clean = extractDeliveryRequest(
      "Customer: Acme\nDeliver 2 pallets of brick to 10 Main Street, Toronto, Ontario on 2026-10-06 at 9am. Call Sam 519-555-0100 on arrival.",
      TODAY,
    );
    const v = validateDelivery(clean.fields, { today: TODAY });
    const d = decideReview({ requiresHumanReview: clean.requires_human_review, aiReason: clean.reason, assessments: clean.field_assessments, ambiguities: clean.ambiguities, validation: v });
    expect(clean.recommended_action).toBe("approve");
    expect(d.needsAttention).toBe(false);
  });
});
