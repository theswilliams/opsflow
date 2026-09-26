import { getEnv } from "@/lib/env";
import { ClaudeProvider } from "./claude-provider";
import { MockAIProvider } from "./mock-provider";
import type { AIProvider } from "./provider";

/**
 * Selects the provider from configuration. Fails loudly rather than silently
 * falling back to the mock: a misconfigured "claude" deployment must not pretend to work.
 */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function getAIProvider(): AIProvider {
  const env = getEnv();
  if (env.AI_PROVIDER === "claude") {
    if (!env.ANTHROPIC_API_KEY) throw new ProviderConfigError("AI_PROVIDER=claude requires ANTHROPIC_API_KEY");
    return ClaudeProvider.fromApiKey(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL);
  }
  return new MockAIProvider();
}

export function isDemoMode(): boolean {
  return getEnv().AI_PROVIDER === "mock";
}
