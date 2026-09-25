import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  AI_PROVIDER: z.enum(["mock", "claude"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  BUSINESS_TIMEZONE: z.string().default("America/Toronto"),
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

export function resetEnvCache() {
  cached = undefined;
}
