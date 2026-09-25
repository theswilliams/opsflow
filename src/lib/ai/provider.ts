export interface ExtractionRequest {
  /** Untrusted document text. Treated strictly as data. */
  text: string;
  /** Business "today" (YYYY-MM-DD) used to resolve relative dates such as "this Friday". */
  referenceDate: string;
  /** Set on retries: structural problems (paths only, never values) found in the previous attempt. */
  feedback?: string;
}

export interface ProviderResponse {
  /** Raw, unvalidated model output. The pipeline validates it; providers must not. */
  output: unknown;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type ProviderErrorCategory = "timeout" | "rate_limited" | "unavailable" | "auth" | "bad_request" | "unknown";

/** Provider failure with a safe, user-presentable category. `cause` is never shown to users. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly category: ProviderErrorCategory,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}

export interface AIProvider {
  readonly name: "claude" | "mock";
  /** True for deterministic demo providers; surfaced in the UI so nobody mistakes it for a live model. */
  readonly isMock: boolean;
  extract(request: ExtractionRequest, options: { signal: AbortSignal }): Promise<ProviderResponse>;
}
