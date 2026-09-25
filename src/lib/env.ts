import { z } from "zod";

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Empty strings (as in .env.example) mean "unset", never "zero". */
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const int = (def: number, min = 0) => z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).default(def));
const optNumber = z.preprocess(emptyToUndefined, z.coerce.number().min(0).optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  AI_PROVIDER: z.enum(["mock", "claude"]).default("mock"),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  ANTHROPIC_MODEL: z.preprocess(emptyToUndefined, z.string().default("claude-sonnet-5")),
  BUSINESS_TIMEZONE: z.preprocess(
    emptyToUndefined,
    z.string().default("America/Toronto").refine(isValidTimezone, "BUSINESS_TIMEZONE must be a valid IANA time zone, e.g. America/Toronto"),
  ),

  // --- AI spend controls (per user). 0 disables that particular ceiling. ---
  AI_DAILY_REQUEST_BUDGET: int(200),
  AI_DAILY_TOKEN_BUDGET: int(400_000),
  /** Only enforced when prices below are configured and the provider reports token usage. */
  AI_MONTHLY_COST_BUDGET_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0).default(0)),
  AI_PRICE_INPUT_USD_PER_MTOK: optNumber,
  AI_PRICE_OUTPUT_USD_PER_MTOK: optNumber,

  // --- Abuse controls ---
  MAX_CREDENTIALS_PER_USER: int(5, 1),
  WEBHOOK_KEY_LIMIT_PER_MIN: int(60, 1),
  WEBHOOK_TENANT_LIMIT_PER_MIN: int(120, 1),

  // --- Client-IP trust model (see docs/SECURITY.md) ---
  /** Comma-separated IPs/CIDRs of reverse proxies whose X-Forwarded-For may be honoured (custom server mode). */
  TRUSTED_PROXIES: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Platform mode (no socket info): number of trusted proxy hops that append to X-Forwarded-For. 0 = none. */
  TRUST_PROXY_HOPS: int(0),

  // --- Background work ---
  JOB_LEASE_SECONDS: int(120, 5),
  JOB_MAX_ATTEMPTS: int(3, 1),
  PDF_TIMEOUT_MS: int(10_000, 100),
  /** Raw documents and extracted personal data are purged this many days after a workflow finishes. 0 disables. */
  RETENTION_DAYS: int(90),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed, validated environment. Throws a descriptive error on misconfiguration. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration — ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: re-read process.env on next getEnv(). */
export function resetEnvCacheForTests() {
  cached = undefined;
}

export function parseEnv(source: Record<string, string | undefined>) {
  return schema.safeParse(source);
}
