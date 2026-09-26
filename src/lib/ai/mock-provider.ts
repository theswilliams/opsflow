import type { AIProvider, ExtractionRequest, ProviderResponse } from "./provider";
import type { Extraction, FieldAssessment, FieldName, Item } from "./schema";
import { parseDateExpression, parseTimeExpression } from "./text-resolvers";

/**
 * Deterministic, rule-based stand-in for an LLM. It exists so the whole product can be
 * evaluated with no API key. It is NOT a language model and the UI labels it as such.
 * It only ever treats the document as data: there is no instruction-following path.
 */

const STREET_SUFFIX =
  "Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Way|Crescent|Cres|Place|Pl|Highway|Hwy|Parkway|Pkwy|Terrace|Trail";
const PROVINCES = ["Ontario", "ON", "Quebec", "QC", "Manitoba", "MB", "Alberta", "AB", "British Columbia", "BC", "Nova Scotia", "NS", "New Brunswick", "NB"];
const UNITS = "pallets?|skids?|boxes|box|bundles?|units?|cases?|rolls?|sheets?|bags?|pieces?|crates?|drums?|pails?|tons?|loads?";
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };

const A = (status: FieldAssessment["status"], confidence: FieldAssessment["confidence"], evidence: string | null = null, note: string | null = null): FieldAssessment => ({
  status,
  confidence,
  evidence: evidence && evidence.length > 300 ? evidence.slice(0, 300) : evidence,
  note,
});
const MISSING = () => A("missing", "unknown");

export class MockAIProvider implements AIProvider {
  readonly name = "mock" as const;
  readonly isMock = true;

  async extract(request: ExtractionRequest): Promise<ProviderResponse> {
    return { output: extractDeliveryRequest(request.text, request.referenceDate), model: "mock-rules-v1" };
  }
}

export function extractDeliveryRequest(text: string, referenceDate: string): Extraction {
  const assess = {} as Record<FieldName, FieldAssessment>;
  const ambiguities: Extraction["ambiguities"] = [];
  const missing: string[] = [];

  // Customer ---------------------------------------------------------------
  let customer: string | null = null;
  const cust = /^\s*(?:customer|company|client|account)\s*[:\-]\s*(.+?)\s*$/im.exec(text);
  if (cust?.[1]) {
    customer = cust[1].slice(0, 200);
    assess.customer = A("known", "high", cust[0].trim());
  } else {
    assess.customer = MISSING();
    missing.push("customer name");
  }

  // Address ----------------------------------------------------------------
  let address: string | null = null;
  const street = new RegExp(`\\b(\\d{1,6}[A-Za-z]?)\\s+((?:[A-Z][\\w.'-]*\\s+){1,3}?(?:${STREET_SUFFIX}))\\b\\.?`, "").exec(text);
  if (street) {
    const parts = [`${street[1]} ${street[2]}`];
    const rest = text.slice(street.index + street[0].length);
    const provinces = PROVINCES.join("|");
    const city = String.raw`[A-Z][a-z]+(?:\s[A-Z][a-z]+)?`;
    const withProvince = new RegExp(String.raw`^(?:,\s*|\s+)(?:(${city})(?:,\s*|\s+))?(${provinces})\b`).exec(rest);
    const cityOnly = new RegExp(String.raw`^,\s*(${city})\b`).exec(rest);
    let evidence = street[0];
    const tail = withProvince ?? cityOnly;
    if (tail) {
      if (tail[1]) parts.push(tail[1]);
      if (withProvince?.[2]) parts.push(withProvince[2]);
      evidence = text.slice(street.index, street.index + street[0].length + tail[0].length).trim();
    }
    address = parts.join(", ");
    assess.address = A("known", parts.length >= 3 ? "high" : "medium", evidence, parts.length >= 3 ? null : "City or province not stated.");
  } else {
    assess.address = MISSING();
    missing.push("delivery address");
  }

  // Date -------------------------------------------------------------------
  let requestedDate: string | null = null;
  const date = parseDateExpression(text, referenceDate);
  if (date.kind === "iso") {
    requestedDate = date.value;
    assess.requested_date = A("known", "high", date.evidence);
  } else if (date.kind === "slash") {
    assess.requested_date = A("ambiguous", "low", date.evidence, "Numeric date could be DD/MM or MM/DD.");
    ambiguities.push({ field: "requested_date", note: `"${date.evidence}" could be read day-first or month-first.` });
    missing.push("unambiguous delivery date");
  } else if (date.kind === "invalid") {
    assess.requested_date = A("ambiguous", "low", date.evidence, "Not a valid calendar date.");
  } else if (date.kind === "none") {
    assess.requested_date = MISSING();
    missing.push("delivery date");
  } else {
    requestedDate = date.value;
    assess.requested_date = A("inferred", date.confidence, date.evidence, date.note);
  }

  // Time -------------------------------------------------------------------
  let window: Extraction["fields"]["requested_time_window"] = null;
  let start: string | null = null;
  let end: string | null = null;
  const time = parseTimeExpression(text);
  if (time.kind === "range") {
    start = time.start;
    end = time.end;
    window = "specific";
    assess.requested_time_window = A("known", "high", time.evidence);
    assess.requested_time_start = A("known", "high", time.evidence);
    assess.requested_time_end = A("known", "high", time.evidence);
  } else if (time.kind === "at") {
    start = time.start;
    window = "specific";
    assess.requested_time_window = A("known", "high", time.evidence);
    assess.requested_time_start = A("known", "high", time.evidence);
    assess.requested_time_end = A("missing", "unknown", null, "Only a start time was given.");
  } else if (time.kind === "daypart") {
    window = time.window;
    assess.requested_time_window = A("ambiguous", "medium", time.phrase, `Only a general "${time.word}" was requested; no specific time.`);
    ambiguities.push({ field: "requested_time_window", note: `Customer asked for "${time.word}" but gave no specific delivery time.` });
    missing.push("specific delivery time");
  } else {
    assess.requested_time_window = MISSING();
    missing.push("delivery time window");
  }
  assess.requested_time_start ??= MISSING();
  assess.requested_time_end ??= MISSING();

  // Items ------------------------------------------------------------------
  const items: Item[] = [];
  const itemRe = new RegExp(
    `\\b(\\d{1,5}|${Object.keys(NUMBER_WORDS).join("|")})\\s+(${UNITS})\\s+(?:of\\s+)?([A-Za-z][A-Za-z0-9 \\-]{2,60}?)(?=\\s+(?:to|for|on|by|at|this|next|tomorrow|delivered|delivery|please|and\\s+\\d)\\b|[.,;\\n]|$)`,
    "gi",
  );
  const evidenceParts: string[] = [];
  for (const m of text.matchAll(itemRe)) {
    const raw = m[1]!.toLowerCase();
    const quantity = raw in NUMBER_WORDS ? NUMBER_WORDS[raw]! : Number(raw);
    items.push({ description: m[3]!.trim().toLowerCase(), quantity, unit: m[2]!.toLowerCase() });
    evidenceParts.push(m[0]);
    if (items.length >= 50) break;
  }
  if (items.length) assess.items = A("known", "high", evidenceParts[0] ?? null);
  else {
    assess.items = MISSING();
    missing.push("items and quantities");
  }

  // Contact ----------------------------------------------------------------
  let contactName: string | null = null;
  let contactPhone: string | null = null;
  const nameMatch = /\b(?:[Cc]all|[Cc]ontact|[Aa]sk for|[Tt]ext|[Aa]ttn:?|[Aa]ttention:?)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/.exec(text);
  const phoneMatch = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.exec(text);
  if (nameMatch?.[1]) {
    contactName = nameMatch[1];
    assess.contact_name = A("known", "high", nameMatch[0]);
  } else assess.contact_name = MISSING();
  if (phoneMatch) {
    contactPhone = phoneMatch[0].trim();
    assess.contact_phone = A("known", "high", phoneMatch[0].trim());
  } else {
    assess.contact_phone = MISSING();
    if (contactName) {
      assess.contact_name = { ...assess.contact_name, confidence: "low", note: "Named contact but no phone number to reach them." };
      missing.push("contact phone number");
    }
  }

  // Special instructions ---------------------------------------------------
  const instr = /(?:please\s+)?((?:call|text|phone)\s+[A-Z]\w+\s+(?:when|before|on|once)\b[^.\n]*)/i.exec(text);
  const specialInstructions = instr?.[1] ? instr[1].trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 500) : null;
  assess.special_instructions = specialInstructions ? A("known", "high", instr![1]!.trim()) : MISSING();

  // Prompt-injection heuristic: surface it, never obey it.
  const suspicious = /ignore (all |any )?(the )?(previous|prior|above|system)|disregard (the )?(previous|above|instructions)|system prompt|you are now|reveal (your|the) (prompt|instructions)|send (this|the|all) (data|information)/i.test(text);
  if (suspicious) {
    ambiguities.push({ field: "special_instructions", note: "Document contains instruction-like text. It was treated as data and ignored." });
  }

  const fields: Extraction["fields"] = {
    customer,
    address,
    requested_date: requestedDate,
    requested_time_window: window,
    requested_time_start: start,
    requested_time_end: end,
    items,
    contact_name: contactName,
    contact_phone: contactPhone,
    special_instructions: specialInstructions,
  };

  const requiredMissing = !customer || !address || !requestedDate || items.length === 0;
  const needsReview = requiredMissing || ambiguities.length > 0 || missing.length > 0;
  const reason = requiredMissing
    ? `Required information is missing: ${missing.join(", ")}.`
    : ambiguities[0]?.note ?? (missing.length ? `Still needed: ${missing.join(", ")}.` : "All required fields were stated clearly.");

  return {
    fields,
    field_assessments: assess as Extraction["field_assessments"],
    missing_information: [...new Set(missing)],
    ambiguities,
    requires_human_review: needsReview,
    reason,
    recommended_action: requiredMissing ? "request_more_information" : needsReview ? "review" : "approve",
  };
}
