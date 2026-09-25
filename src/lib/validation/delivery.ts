import { diffDays, isValidIsoDate, weekdayIndex } from "@/lib/dates";
import type { ExtractedFields } from "@/lib/ai/schema";

/**
 * Deterministic validation of an extracted delivery request.
 * Pure: no I/O, no AI. The same input always yields the same issues.
 */

export type Severity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  field: string;
  severity: Severity;
  message: string;
}

export interface ValidationContext {
  /** Business "today", YYYY-MM-DD. */
  today: string;
  /** Existing non-terminal workflows that look like this one (resolved by the service). */
  duplicates?: { id: string }[];
  workflowType?: string;
}

export interface ValidationOutcome {
  passed: boolean;
  errorCount: number;
  warningCount: number;
  issues: ValidationIssue[];
}

export const ALLOWED_WORKFLOW_TYPES = ["DELIVERY_REQUEST"];
const DISCRETE_UNIT = /^(pallets?|skids?|boxes|box|bundles?|units?|cases?|rolls?|sheets?|bags?|pieces?|crates?|drums?|pails?|loads?)$/i;
const MAX_QUANTITY = 5000;
const MIN_HOUR = 6;
const MAX_HOUR = 20;

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};
const STREET_SUFFIX = /\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|way|crescent|cres|place|pl|highway|hwy|parkway|pkwy|terrace|trail)\b\.?/i;

export function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

export function validateDelivery(fields: ExtractedFields, ctx: ValidationContext): ValidationOutcome {
  const issues: ValidationIssue[] = [];
  const add = (severity: Severity, field: string, code: string, message: string) => issues.push({ severity, field, code, message });

  if (ctx.workflowType && !ALLOWED_WORKFLOW_TYPES.includes(ctx.workflowType)) {
    add("error", "type", "TYPE_NOT_ALLOWED", `Workflow type "${ctx.workflowType}" is not supported.`);
  }

  // Customer ---------------------------------------------------------------
  if (!fields.customer?.trim()) add("error", "customer", "CUSTOMER_MISSING", "Customer name is required.");

  // Address ----------------------------------------------------------------
  const address = fields.address?.trim();
  if (!address) {
    add("error", "address", "ADDRESS_MISSING", "Delivery address is required.");
  } else if (/\b(p\.?\s?o\.?\s?box|postal box)\b/i.test(address)) {
    add("error", "address", "ADDRESS_PO_BOX", "Deliveries cannot be made to a PO Box.");
  } else if (!/\b\d{1,6}[A-Za-z]?\s+[A-Za-z0-9.'-]+/.test(address)) {
    add("error", "address", "ADDRESS_MALFORMED", "Address should include a street number and street name.");
  } else {
    const suffix = STREET_SUFFIX.exec(address);
    const rest = suffix ? address.slice(suffix.index + suffix[0].length).replace(/^[\s,.]+/, "") : "";
    const hasLocality = suffix ? rest.length >= 3 : /,\s*\S{3,}/.test(address);
    if (!hasLocality) add("warning", "address", "ADDRESS_NO_LOCALITY", "Address has no city or province — confirm the delivery location.");
  }

  // Date -------------------------------------------------------------------
  const date = fields.requested_date;
  if (!date) {
    add("error", "requested_date", "DATE_MISSING", "Delivery date is required.");
  } else if (!isValidIsoDate(date)) {
    add("error", "requested_date", "DATE_INVALID", "Delivery date is not a valid calendar date.");
  } else {
    const ahead = diffDays(date, ctx.today);
    if (ahead < 0) add("error", "requested_date", "DATE_IN_PAST", "Delivery date is in the past.");
    else if (ahead === 0) add("warning", "requested_date", "DATE_TODAY", "Same-day delivery requested — confirm capacity.");
    else if (ahead > 180) add("warning", "requested_date", "DATE_FAR_FUTURE", "Delivery date is more than six months away.");
    if (ahead >= 0 && weekdayIndex(date) === 0) add("warning", "requested_date", "DATE_SUNDAY", "Requested date is a Sunday.");
  }

  // Time -------------------------------------------------------------------
  const { requested_time_window: window, requested_time_start: start, requested_time_end: end } = fields;
  if (start && end && minutes(end) <= minutes(start)) {
    add("error", "requested_time_end", "TIME_RANGE_INVALID", "End time must be after the start time.");
  } else if (start && end && minutes(end) - minutes(start) > 12 * 60) {
    add("warning", "requested_time_end", "TIME_RANGE_WIDE", "Delivery window is longer than 12 hours.");
  }
  if (window === "specific" && !start) {
    add("error", "requested_time_start", "TIME_START_MISSING", "A specific time window needs a start time.");
  }
  for (const [key, value] of [["requested_time_start", start], ["requested_time_end", end]] as const) {
    if (value) {
      const h = Number(value.slice(0, 2));
      if (h < MIN_HOUR || h > MAX_HOUR || (h === MAX_HOUR && value.slice(3) !== "00")) {
        add("warning", key, "TIME_OUTSIDE_HOURS", `Time ${value} is outside normal delivery hours (${MIN_HOUR}:00–${MAX_HOUR}:00).`);
      }
    }
  }
  if (!window || window === "unspecified") {
    add("warning", "requested_time_window", "TIME_NOT_PROVIDED", "No delivery time or window was given.");
  } else if (window !== "specific" && !start) {
    add("warning", "requested_time_window", "TIME_NOT_SPECIFIC", `Only a general "${window}" window was given — set a specific time before approving if the customer needs one.`);
  }

  // Items ------------------------------------------------------------------
  if (fields.items.length === 0) {
    add("error", "items", "ITEMS_MISSING", "At least one item is required.");
  }
  fields.items.forEach((item, i) => {
    const label = `Item ${i + 1} (${item.description})`;
    if (item.quantity === null) add("error", "items", "QUANTITY_MISSING", `${label}: quantity is missing.`);
    else if (!(item.quantity > 0)) add("error", "items", "QUANTITY_INVALID", `${label}: quantity must be greater than zero.`);
    else {
      if (item.unit && DISCRETE_UNIT.test(item.unit) && !Number.isInteger(item.quantity)) {
        add("error", "items", "QUANTITY_NOT_WHOLE", `${label}: ${item.unit} must be a whole number.`);
      }
      if (item.quantity > MAX_QUANTITY) add("warning", "items", "QUANTITY_LARGE", `${label}: quantity ${item.quantity} is unusually large.`);
    }
    if (!item.unit) add("warning", "items", "UNIT_MISSING", `${label}: no unit given.`);
  });

  // Contact ----------------------------------------------------------------
  const phone = fields.contact_phone?.trim();
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith("1")))) {
      add("error", "contact_phone", "PHONE_INVALID", "Phone number must have 10 digits (North American format).");
    }
  } else if (fields.contact_name) {
    add("warning", "contact_phone", "CONTACT_PHONE_MISSING", `No phone number for ${fields.contact_name}, who is to be called.`);
  } else {
    add("warning", "contact_name", "CONTACT_MISSING", "No on-site contact was given.");
  }

  // Duplicates -------------------------------------------------------------
  if (ctx.duplicates?.length) {
    add("warning", "duplicate", "DUPLICATE_SUSPECTED", `Looks like a duplicate of workflow ${ctx.duplicates.map((d) => d.id).join(", ")} (same customer, address and date).`);
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  return { passed: errorCount === 0, errorCount, warningCount: issues.length - errorCount, issues };
}
