/** Presentation helpers shared by server components. */

const TZ = () => process.env.BUSINESS_TIMEZONE || "America/Toronto";

export function formatDateTime(d: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(d));
}

export function formatTime(d: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(d));
}

export function formatFullDateTime(d: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), dateStyle: "medium", timeStyle: "medium" }).format(new Date(d));
}

export function relativeTime(d: Date | string, now = Date.now()): string {
  const s = Math.round((now - new Date(d).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return `${days} d ago`;
}

/** Compact duration since `d`: "12 min", "3 h", "2 d". */
export function ageLabel(d: Date | string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(d).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** Urgency of a request that has been waiting for review: >24 h needs a nudge, >72 h is overdue. */
export function ageTone(d: Date | string, now = Date.now()): "normal" | "warn" | "urgent" {
  const hours = (now - new Date(d).getTime()) / 3_600_000;
  return hours > 72 ? "urgent" : hours > 24 ? "warn" : "normal";
}

export const shortId = (id: string) => id.slice(-8).toUpperCase();

export const TYPE_LABEL: Record<string, string> = { DELIVERY_REQUEST: "Delivery request" };
export const SOURCE_LABEL: Record<string, string> = { PASTE: "Pasted text", UPLOAD: "Uploaded document", WEBHOOK: "Webhook" };

export const FIELD_LABEL: Record<string, string> = {
  customer: "Customer",
  address: "Delivery address",
  requested_date: "Requested date",
  requested_time_window: "Time window",
  requested_time_start: "Start time",
  requested_time_end: "End time",
  items: "Items",
  contact_name: "Contact",
  contact_phone: "Contact phone",
  special_instructions: "Instructions",
  duplicate: "Duplicate check",
  type: "Workflow type",
};
