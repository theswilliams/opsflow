import { logger } from "@/lib/logger";
import { INJECTION_PATTERN, verifyEvidence, type Span } from "./evidence";
import { ProviderError, type AIProvider } from "./provider";
import { extractionSchema, FIELD_NAMES, type Confidence, type Extraction, type FieldAssessment, type FieldName } from "./schema";

export const MAX_INPUT_CHARS = 20_000;

export type ExtractionErrorCode = "INPUT_EMPTY" | "INPUT_TOO_LARGE" | "PROVIDER_FAILED" | "MALFORMED_OUTPUT" | "TIMEOUT" | "BUDGET_EXCEEDED";

export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    /** Safe to show to end users. */
    readonly userMessage: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(`${code}: ${userMessage}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExtractionError";
    /** Whether trying the same job again later could plausibly succeed (timeouts, outages) — vs deterministic failures. */
    this.retryable = options?.retryable ?? false;
  }

  readonly retryable: boolean;
}

export interface AttemptUsage {
  ok: boolean;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ExtractionOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Called before every provider request; throw ExtractionError to stop (e.g. budget exhausted). */
  beforeAttempt?: () => Promise<void> | void;
  /** Called after every provider request — successful or not — so spend is always recorded. */
  onAttempt?: (usage: AttemptUsage) => Promise<void> | void;
}

/** The stored form of an assessment: the model's claim plus what OpsFlow independently verified. */
export type VerifiedAssessment = FieldAssessment & {
  /** True only if the quoted evidence was found in the document AND supports this field's value. */
  verified?: boolean;
  /** Location of the evidence in the cleaned source text, computed by OpsFlow (never by the model). */
  span?: Span | null;
  edited?: boolean;
};

export type ReconciledExtraction = Omit<Extraction, "field_assessments"> & { field_assessments: Record<FieldName, VerifiedAssessment> };

export interface ExtractionOutcome {
  extraction: ReconciledExtraction;
  provider: string;
  model: string;
  attempts: number;
  durationMs: number;
  /** Human-readable notes about corrections the pipeline applied to the model output. */
  corrections: string[];
}

/** Removes control characters (keeps \n and \t) so hostile bytes never reach the model or the UI. */
export function cleanText(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, "");
}

const CONF_RANK: Record<Confidence, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
const capConfidence = (c: Confidence, max: Confidence): Confidence => (CONF_RANK[c] > CONF_RANK[max] ? max : c);

function hasValue(fields: Extraction["fields"], name: FieldName): boolean {
  const v = fields[name];
  return Array.isArray(v) ? v.length > 0 : v !== null && v !== "";
}

const REQUIRED: FieldName[] = ["customer", "address", "requested_date", "items"];

/**
 * The model's output is untrusted. After schema validation we still:
 *  1. enforce status/value consistency;
 *  2. verify each field's evidence deterministically (found in the document, meaningful, and actually
 *     supporting THAT field's value) — unsupported claims are downgraded to "ambiguous / low";
 *  3. take over the review decision: the model cannot declare its own output trustworthy.
 */
export function reconcileExtraction(
  extraction: Extraction,
  sourceText: string,
  referenceDate: string,
): { extraction: ReconciledExtraction; corrections: string[] } {
  const corrections: string[] = [];
  const out = structuredClone(extraction) as ReconciledExtraction;
  let unsupported = 0;

  for (const name of FIELD_NAMES) {
    const a = out.field_assessments[name];
    const present = hasValue(out.fields, name);

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
    if (!present) {
      a.evidence = null;
      a.verified = false;
      a.span = null;
      if (a.status === "missing") a.confidence = "unknown";
      continue;
    }

    const verdict = verifyEvidence({ field: name, fields: out.fields, quote: a.evidence, source: sourceText, referenceDate });
    if (verdict.supported) {
      a.verified = true;
      a.span = verdict.span;
      continue;
    }
    unsupported++;
    corrections.push(`${name}: evidence rejected (${verdict.reason})`);
    a.verified = false;
    a.span = null;
    a.evidence = null;
    a.confidence = capConfidence(a.confidence, "low");
    if (a.status === "known" || a.status === "inferred") a.status = "ambiguous";
    a.note = [a.note, `The AI could not point to text in the document that supports this value (${verdict.reason}).`].filter(Boolean).join(" ");
    if (!out.ambiguities.some((x) => x.field === name)) out.ambiguities.push({ field: name, note: `Unverified: ${verdict.reason}.` });
  }

  if (INJECTION_PATTERN.test(sourceText) && !out.ambiguities.some((x) => /instruction-like/i.test(x.note))) {
    out.ambiguities.push({ field: "special_instructions", note: "Document contains instruction-like text. It was treated as data and ignored." });
    corrections.push("document contains instruction-like text");
  }

  const requiredMissing = REQUIRED.some((n) => !hasValue(out.fields, n));
  const needsReview = extraction.requires_human_review || unsupported > 0 || out.ambiguities.length > 0 || out.missing_information.length > 0 || requiredMissing;
  out.requires_human_review = needsReview;
  out.recommended_action = requiredMissing ? "request_more_information" : needsReview ? "review" : "approve";
  if (unsupported > 0) out.reason = `${out.reason} ${unsupported} value(s) could not be verified against the document.`.trim().slice(0, 500);
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
    await options.beforeAttempt?.();
    try {
      const response = await provider.extract(
        { text, referenceDate: input.referenceDate, feedback },
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      await options.onAttempt?.({ ok: true, model: response.model, inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens });
      const parsed = extractionSchema.safeParse(response.output);
      if (!parsed.success) {
        feedback = issueSummary(parsed.error);
        lastError = new ExtractionError("MALFORMED_OUTPUT", "The AI response did not match the expected structure.");
        logger.warn("ai.extraction.malformed", { provider: provider.name, attempt, issues: feedback });
      } else {
        const { extraction, corrections } = reconcileExtraction(parsed.data, text, input.referenceDate);
        return { extraction, provider: provider.name, model: response.model, attempts: attempt, durationMs: Date.now() - started, corrections };
      }
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      lastError = err;
      await options.onAttempt?.({ ok: false, model: provider.name });
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
    throw new ExtractionError("TIMEOUT", "The AI provider took too long to respond.", { cause: lastError, retryable: true });
  }
  if (lastError instanceof ProviderError) {
    const message =
      lastError.category === "auth"
        ? "The AI provider is not configured correctly. Contact an administrator."
        : "The AI provider is temporarily unavailable.";
    throw new ExtractionError("PROVIDER_FAILED", message, { cause: lastError, retryable: lastError.category !== "auth" && lastError.category !== "bad_request" });
  }
  throw new ExtractionError("PROVIDER_FAILED", "AI extraction failed unexpectedly.", { cause: lastError, retryable: true });
}
