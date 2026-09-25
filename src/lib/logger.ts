/**
 * Structured JSON logging with defensive redaction.
 * Anything that looks like a secret, or free-form document content, is masked.
 */
type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|signature|cookie|text|content|body|email|phone|address/i;
const MAX_STRING = 200;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  if (typeof value !== "object") return value;
  if (depth > 4) return "[depth-limit]";
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (process.env.VITEST && !process.env.OPSFLOW_LOG_IN_TESTS) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as object) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log("error", event, fields),
};
