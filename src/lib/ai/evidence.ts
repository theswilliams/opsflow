import { normalizeAddress, normalizeCustomer } from "@/lib/validation/normalize";
import { clockTimesIn, parseDateExpression } from "./text-resolvers";
import type { ExtractedFields, FieldName } from "./schema";

/**
 * Deterministic evidence verification.
 *
 * The model proposes a value AND a quote. We never accept the model's word that the quote is
 * valid: we (1) locate the quote in the source ourselves, obtaining a real source span, and
 * (2) check with field-specific rules that the quote actually contains/implies the value.
 * A quote such as "the" fails (1)'s meaningfulness check and (2)'s support check for every field.
 */

export interface Span {
  start: number;
  end: number;
}

export type EvidenceVerdict = { supported: true; span: Span } | { supported: false; reason: string };

const STOP = new Set(
  "a an the and or but of to in on at for from by with as is are was were be been this that these those it its we you i he she they them our your my his her their please can could would will shall may might should do does did has have had not no yes if then so than too very just also about into over per via re fw fwd hi hello dear thanks thank regards address customer client date time name phone contact deliver delivery delivered send ship order request item items"
    .split(" "),
);

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:.@-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (s: string) => fold(s).split(/[\s,;.]+/).filter(Boolean);
const meaningful = (s: string) => tokens(s).filter((t) => !STOP.has(t) && (t.length >= 3 || /\d/.test(t)));
const digits = (s: string) => s.replace(/\D/g, "");

/** Finds the quote in the source (whitespace/case-insensitive) and returns real offsets, or null. */
export function locateQuote(source: string, quote: string): Span | null {
  const q = quote.trim();
  if (q.length < 3) return null;
  const pattern = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const m = new RegExp(pattern, "i").exec(source);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12" };
const hasNumber = (text: string, n: number) => {
  const t = tokens(text);
  return t.includes(String(n)) || t.some((w) => NUMBER_WORDS[w] === String(n));
};

type Item = ExtractedFields["items"][number];
const itemSupported = (text: string, item: Item) => {
  const desc = meaningful(item.description);
  const t = new Set(tokens(text).flatMap((w) => [w, w.replace(/s$/, "")]));
  const descOk = desc.length > 0 && desc.every((w) => t.has(w) || t.has(w.replace(/s$/, "")));
  return descOk && (item.quantity === null || hasNumber(text, item.quantity));
};

/** Does `quote` genuinely support `value` for this field? `source` is the whole (cleaned) document. */
function supports(field: FieldName, fields: ExtractedFields, quote: string, source: string, referenceDate: string): string | null {
  switch (field) {
    case "customer": {
      const key = normalizeCustomer(fields.customer ?? "");
      return key && fold(quote).includes(key) ? null : "quote does not contain the customer name";
    }
    case "address": {
      const value = normalizeAddress(fields.address ?? "").split(" ");
      const q = new Set(normalizeAddress(quote).split(" "));
      const number = value.find((t) => /^\d+[a-z]?$/.test(t));
      const name = value.find((t) => /^[a-z]{3,}$/.test(t));
      if (!number || !name) return "address has no street number and name to verify";
      return q.has(number) && q.has(name) ? null : "quote does not contain the street number and name";
    }
    case "requested_date": {
      const parsed = parseDateExpression(quote, referenceDate);
      return "value" in parsed && parsed.value === fields.requested_date ? null : "quote does not resolve to the extracted date";
    }
    case "requested_time_window": {
      const w = fields.requested_time_window;
      if (w === "specific") return clockTimesIn(quote).length ? null : "quote contains no clock time";
      if (w === "unspecified") return null;
      const words = w === "morning" ? ["morning", "first thing"] : w === "afternoon" ? ["afternoon", "end of day"] : ["evening"];
      return words.some((x) => fold(quote).includes(x)) ? null : `quote does not mention "${w}"`;
    }
    case "requested_time_start":
    case "requested_time_end": {
      const v = fields[field];
      return v && clockTimesIn(quote).includes(v) ? null : "quote does not contain that clock time";
    }
    case "items": {
      if (!fields.items.length) return "no items to verify";
      if (!fields.items.some((i) => itemSupported(quote, i))) return "quote does not contain an item with its quantity";
      return fields.items.every((i) => itemSupported(source, i)) ? null : "an extracted item is not present in the document";
    }
    case "contact_name":
      return fold(quote).includes(fold(fields.contact_name ?? "")) && fold(fields.contact_name ?? "") ? null : "quote does not contain the contact name";
    case "contact_phone": {
      const v = digits(fields.contact_phone ?? "").slice(-10);
      return v.length >= 7 && digits(quote).includes(v) ? null : "quote does not contain the phone number";
    }
    case "special_instructions": {
      const want = meaningful(fields.special_instructions ?? "");
      const have = new Set(tokens(quote));
      if (!want.length) return "instructions contain no verifiable words";
      return want.filter((w) => have.has(w)).length / want.length >= 0.6 ? null : "quote does not contain the instructions";
    }
  }
}

export function verifyEvidence(args: {
  field: FieldName;
  fields: ExtractedFields;
  quote: string | null;
  source: string;
  referenceDate: string;
}): EvidenceVerdict {
  const { field, fields, quote, source, referenceDate } = args;
  if (!quote?.trim()) return { supported: false, reason: "no evidence quoted" };
  if (meaningful(quote).length === 0) return { supported: false, reason: "evidence is only generic words" };
  const span = locateQuote(source, quote);
  if (!span) return { supported: false, reason: "quote not found in the document" };
  const problem = supports(field, fields, quote, source, referenceDate);
  return problem ? { supported: false, reason: problem } : { supported: true, span };
}

export const INJECTION_PATTERN =
  /ignore (all |any )?(the )?(previous|prior|above|system)|disregard (the )?(previous|above|instructions)|system prompt|you are now|reveal (your|the) (prompt|instructions)|send (this|the|all) (data|information)|mark (all|every) (fields?|values?) (as )?(verified|known|confirmed)|auto[- ]?approve|approve (this|it) (automatically|immediately)/i;
