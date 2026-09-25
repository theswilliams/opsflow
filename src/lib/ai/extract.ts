import { logger } from "@/lib/logger";
import { ProviderError, type AIProvider } from "./provider";
import { extractionSchema, FIELD_NAMES, type Confidence, type Extraction, type FieldName } from "./schema";

export const MAX_INPUT_CHARS = 20_000;

export type ExtractionErrorCode = "INPUT_EMPTY" | "INPUT_TOO_LARGE" | "PROVIDER_FAILED" | "MALFORMED_OUTPUT" | "TIMEOUT";

export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    /** Safe to show to end users. */
    readonly userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${userMessage}`, options);
    this.name = "ExtractionError";
  }
}

export interface ExtractionOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface ExtractionOutcome {
  extraction: Extraction;
  provider: string;
  model: string;
  attempts: number;
  durationMs: number;
  /** Human-readable notes about corrections the pipeline applied to the model output. */
  corrections: string[];
}

/** Removes control characters (keeps \n and \t) so hostile bytes never reach the model or the UI. */
export function cleanText(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, "");
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const CONF_RANK: Record<Confidence, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
const capConfidence = (c: Confidence, max: Confidence): Confidence => (CONF_RANK[c] > CONF_RANK[max] ? max : c);

function hasValue(fields: Extraction["fields"], name: FieldName): boolean {
  const v = fields[name];
  return Array.isArray(v) ? v.length > 0 : v !== null && v !== "";
}

/**
 * The model's output is untrusted. After schema validation we still enforce
 * cross-field consistency and verify that cited evidence really exists in the source.
 */
export function reconcileExtraction(extraction: Extraction, sourceText: string): { extraction: Extraction; corrections: string[] } {
  const corrections: string[] = [];
  const source = norm(sourceText);
  const out: Extraction = structuredClone(extraction);

  for (const name of FIELD_NAMES) {
    const a = out.field_assessments[name];
    const present = hasValue(out.fields, name);

    if (a.evidence && !source.includes(norm(a.evidence))) {
      corrections.push(`${name}: cited evidence not found in the source text`);
      a.evidence = null;
      if (a.status === "known") a.status = "inferred";
      a.confidence = capConfidence(a.confidence, "medium");
      a.note = [a.note, "Cited evidence could not be verified in the source text."].filter(Boolean).join(" ");
    }
    if (present && a.status === "missing") {
      corrections.push(`${name}: value present but marked missing`);
      a.status = "inferred";
      a.confidence = capConfidence(a.confidence, "low");
    }
    if (!present && (a.status === "known" || a.status === "inferred")) {
      corrections.push(`${name}: marked ${a.status} but no value`);
      a.status = "missing";
      a.confidence = "unknown";
    }
    if (!present && a.status === "missing") a.confidence = "unknown";
  }
  return { extraction: out, corrections };
}

function issueSummary(error: { issues: { path: PropertyKey[]; code: string }[] }): string {
  // Paths and codes only — never echo model-produced values back into a prompt.
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join(".") || "(root)"} (${i.code})`)
    .join("; ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function extractWorkflowData(
  provider: AIProvider,
  input: { text: string; referenceDate: string },
  options: ExtractionOptions = {},
): Promise<ExtractionOutcome> {
  const { maxAttempts = 2, timeoutMs = 30_000, retryDelayMs = 500 } = options;
  const text = cleanText(input.text).trim();
  if (!text) throw new ExtractionError("INPUT_EMPTY", "The request contained no text to process.");
  if (text.length > MAX_INPUT_CHARS) {
    throw new ExtractionError("INPUT_TOO_LARGE", `The request is too long (limit ${MAX_INPUT_CHARS.toLocaleString("en-CA")} characters).`);
  }

  const started = Date.now();
  let feedback: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await provider.extract(
        { text, referenceDate: input.referenceDate, feedback },
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      const parsed = extractionSchema.safeParse(response.output);
      if (!parsed.success) {
        feedback = issueSummary(parsed.error);
        lastError = new ExtractionError("MALFORMED_OUTPUT", "The AI response did not match the expected structure.");
        logger.warn("ai.extraction.malformed", { provider: provider.name, attempt, issues: feedback });
      } else {
        const { extraction, corrections } = reconcileExtraction(parsed.data, text);
        return { extraction, provider: provider.name, model: response.model, attempts: attempt, durationMs: Date.now() - started, corrections };
      }
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError) {
        logger.warn("ai.extraction.provider_error", { provider: provider.name, attempt, category: err.category });
        if (!err.retryable) break;
      } else {
        logger.error("ai.extraction.unexpected", { provider: provider.name, attempt, error: err });
      }
    }
    if (attempt < maxAttempts && retryDelayMs) await sleep(retryDelayMs * attempt);
  }

  if (lastError instanceof ExtractionError) throw lastError;
  if (lastError instanceof ProviderError && lastError.category === "timeout") {
    throw new ExtractionError("TIMEOUT", "The AI provider took too long to respond.", { cause: lastError });
  }
  if (lastError instanceof ProviderError) {
    const message =
      lastError.category === "auth"
        ? "The AI provider is not configured correctly. Contact an administrator."
        : "The AI provider is temporarily unavailable.";
    throw new ExtractionError("PROVIDER_FAILED", message, { cause: lastError });
  }
  throw new ExtractionError("PROVIDER_FAILED", "AI extraction failed unexpectedly.", { cause: lastError });
}
