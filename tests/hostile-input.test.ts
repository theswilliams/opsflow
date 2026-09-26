/**
 * Worst-case-size hostile text through every pure text-processing step. Guards against catastrophic regex
 * backtracking (ReDoS) and against unexpected Unicode changing the outcome of matching or normalisation.
 * The time bound is deliberately generous (a backtracking bug would take minutes, not milliseconds).
 */
import { describe, expect, it } from "vitest";
import { cleanText, MAX_INPUT_CHARS, reconcileExtraction } from "@/lib/ai/extract";
import { locateQuote } from "@/lib/ai/evidence";
import { extractDeliveryRequest } from "@/lib/ai/mock-provider";
import { parseDateExpression, parseTimeExpression } from "@/lib/ai/text-resolvers";
import { normalizeAddress, normalizeCustomer } from "@/lib/validation/normalize";
import { TODAY } from "./helpers";

const N = MAX_INPUT_CHARS;
const MAX_MS = 2_000;

const hostile: Record<string, string> = {
  "spaces": " ".repeat(N),
  "digits": "1".repeat(N),
  "commas": ",".repeat(N),
  "date-like": "1/".repeat(N / 2),
  "time-like": "12:".repeat(N / 3),
  "month names": "may ".repeat(N / 4),
  "punctuation": "!?.;:-".repeat(N / 6),
  "street-like": "1 main ".repeat(N / 7),
  "customer-like": "Customer: ".repeat(N / 10),
  "quantities": "4 pallets of ".repeat(N / 13),
  "unterminated quote": '"' + "a".repeat(N - 1),
  "combining marks": "é".repeat(N / 2),
  "zero-width": "a​".repeat(N / 2),
  "right-to-left": "‮" + "abc ".repeat(N / 4),
  "emoji": "\u{1F69B}".repeat(N / 2),
  "newlines": "\n".repeat(N),
  "html and script": "<script>alert(1)</script>".repeat(N / 25),
};

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
}

describe.each(Object.entries(hostile))("hostile text: %s", (_name, text) => {
  it("is processed by every text step in bounded time and never throws", () => {
    const steps: Array<[string, () => unknown]> = [
      ["cleanText", () => cleanText(text)],
      ["parseDateExpression", () => parseDateExpression(text, TODAY)],
      ["parseTimeExpression", () => parseTimeExpression(text)],
      ["normalizeCustomer", () => normalizeCustomer(text)],
      ["normalizeAddress", () => normalizeAddress(text)],
      ["locateQuote", () => locateQuote(text, "2 pallets of brick to 10 Main Street")],
      ["mock extraction", () => extractDeliveryRequest(cleanText(text), TODAY)],
    ];
    for (const [step, run] of steps) {
      const { ms } = timed(run);
      expect(ms, `${step} took ${Math.round(ms)}ms`).toBeLessThan(MAX_MS);
    }
  });

  it("nothing is reported as known without verified evidence", () => {
    const source = cleanText(text);
    const extraction = extractDeliveryRequest(source, TODAY);
    const { ms } = timed(() => reconcileExtraction(extraction, source, TODAY));
    expect(ms).toBeLessThan(MAX_MS);
    const { extraction: out } = reconcileExtraction(extraction, source, TODAY);
    // No field may be presented as known unless its quote was verified against the document.
    for (const a of Object.values(out.field_assessments)) if (a.status === "known") expect(a.verified).toBe(true);
  });
});

describe("unexpected Unicode does not change what is considered the same customer", () => {
  it("normalises compatibility forms, accents and casing consistently", () => {
    expect(normalizeCustomer("ＡＢＣ Building Supplies Ltd.")).toBe(normalizeCustomer("abc building supplies limited"));
    expect(normalizeCustomer("Café  Métro Inc")).toBe(normalizeCustomer("cafe metro incorporated"));
  });
});
