import { addDays, isValidIsoDate, weekdayIndex, WEEKDAYS } from "@/lib/dates";

/**
 * Deterministic interpretation of date/time phrases. Used by the mock provider to extract, and by the
 * evidence verifier to check that a quote really means what the model says it means.
 */
export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export type DateParse =
  | { kind: "none" }
  | { kind: "iso" | "monthday" | "relative" | "weekday"; value: string; evidence: string; note: string | null; confidence: "high" | "medium" }
  | { kind: "slash"; value: null; evidence: string }
  | { kind: "invalid"; value: null; evidence: string };

export function parseDateExpression(text: string, referenceDate: string): DateParse {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso?.[1] && isValidIsoDate(iso[1])) return { kind: "iso", value: iso[1], evidence: iso[0], note: null, confidence: "high" };

  const slash = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
  if (slash) return { kind: "slash", value: null, evidence: slash[0] };

  const monthDay = new RegExp(`\\b(${MONTHS.map((m) => m.slice(0, 3)).join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i").exec(text);
  if (monthDay?.[1] && monthDay[2]) {
    const month = MONTHS.findIndex((m) => m.startsWith(monthDay[1]!.toLowerCase())) + 1;
    const day = Number(monthDay[2]);
    let year = Number(referenceDate.slice(0, 4));
    const fmt = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let candidate = fmt(year);
    if (isValidIsoDate(candidate) && candidate < referenceDate) {
      year += 1;
      candidate = fmt(year);
    }
    return isValidIsoDate(candidate)
      ? { kind: "monthday", value: candidate, evidence: monthDay[0], note: "Year inferred from the request date.", confidence: "medium" }
      : { kind: "invalid", value: null, evidence: monthDay[0] };
  }

  const relative = /\b(today|tomorrow)\b/i.exec(text);
  if (relative?.[1]) {
    const value = relative[1].toLowerCase() === "today" ? referenceDate : addDays(referenceDate, 1);
    return { kind: "relative", value, evidence: relative[0], note: `Resolved against request date ${referenceDate}.`, confidence: "high" };
  }

  const weekday = new RegExp(`\\b(?:(this|next|on|by)\\s+)?(${WEEKDAYS.join("|")})\\b`, "i").exec(text);
  if (weekday?.[2]) {
    const target = WEEKDAYS.indexOf(weekday[2].toLowerCase() as (typeof WEEKDAYS)[number]);
    let ahead = (target - weekdayIndex(referenceDate) + 7) % 7;
    if (ahead === 0) ahead = 7;
    const isNext = weekday[1]?.toLowerCase() === "next";
    if (isNext && ahead <= 2) ahead += 7;
    return {
      kind: "weekday",
      value: addDays(referenceDate, ahead),
      evidence: weekday[0],
      note: `Resolved "${weekday[0]}" against request date ${referenceDate}.`,
      confidence: isNext ? "medium" : "high",
    };
  }
  return { kind: "none" };
}

const to24 = (h: number, m: number, mer: string | undefined, fallbackMer?: string) => {
  let hour = h;
  const meridiem = (mer ?? fallbackMer)?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

export type TimeParse =
  | { kind: "range"; start: string; end: string; evidence: string }
  | { kind: "at"; start: string; evidence: string }
  | { kind: "daypart"; window: "morning" | "afternoon" | "evening"; word: string; phrase: string }
  | { kind: "none" };

export function parseTimeExpression(text: string): TimeParse {
  const range = /\bbetween\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:and|-|to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (range) {
    const endMer = range[6];
    return { kind: "range", start: to24(Number(range[1]), Number(range[2] ?? 0), range[3], endMer), end: to24(Number(range[4]), Number(range[5] ?? 0), endMer), evidence: range[0] };
  }
  const at = /\b(?:at|around|by|before)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (at) return { kind: "at", start: to24(Number(at[1]), Number(at[2] ?? 0), at[3]), evidence: at[0] };
  const dayPart = /\b(morning|afternoon|evening|first thing|end of day)\b/i.exec(text);
  if (dayPart?.[1]) {
    const word = dayPart[1].toLowerCase();
    const window = word === "afternoon" || word === "end of day" ? "afternoon" : word === "evening" ? "evening" : "morning";
    const phrase = /\b(?:(?:this|next|on)\s+)?(?:\w+day\s+)?(?:first thing\s+)?(?:in the\s+)?(morning|afternoon|evening|end of day)/i.exec(text)?.[0] ?? dayPart[0];
    return { kind: "daypart", window, word, phrase };
  }
  return { kind: "none" };
}

/** Every clock time mentioned in the text, as HH:MM (24h). */
export function clockTimesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)) out.add(to24(Number(m[1]), Number(m[2] ?? 0), m[3]));
  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) out.add(`${m[1]!.padStart(2, "0")}:${m[2]}`);
  return [...out];
}
