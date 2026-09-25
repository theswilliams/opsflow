import Anthropic from "@anthropic-ai/sdk";
import { extractionJsonSchema } from "./schema";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { ProviderError, type AIProvider, type ExtractionRequest, type ProviderResponse } from "./provider";

const TOOL_NAME = "record_extraction";

/** The slice of the Anthropic SDK we depend on — lets tests inject a fake client. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
  };
}

export class ClaudeProvider implements AIProvider {
  readonly name = "claude" as const;
  readonly isMock = false;

  constructor(
    private readonly model: string,
    private readonly client: MessagesClient,
  ) {}

  static fromApiKey(apiKey: string, model: string) {
    // Retries are owned by the extraction pipeline, so the SDK's own retry is disabled.
    return new ClaudeProvider(model, new Anthropic({ apiKey, maxRetries: 0 }));
  }

  async extract(request: ExtractionRequest, { signal }: { signal: AbortSignal }): Promise<ProviderResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 2048,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserMessage(request) }],
          tools: [
            {
              name: TOOL_NAME,
              description: "Record the structured extraction for this delivery request.",
              input_schema: extractionJsonSchema() as Anthropic.Tool.InputSchema,
            },
          ],
          tool_choice: { type: "tool", name: TOOL_NAME },
        },
        { signal },
      );
    } catch (err) {
      throw mapError(err, signal);
    }

    const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME);
    if (!block) throw new ProviderError("Model did not return the required tool call", "unknown", true);
    return {
      output: block.input,
      model: message.model,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

function mapError(err: unknown, signal: AbortSignal): ProviderError {
  if (signal.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError"))) {
    return new ProviderError("AI provider timed out", "timeout", true, { cause: err });
  }
  const status = typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : undefined;
  if (status === 401 || status === 403) return new ProviderError("AI provider rejected credentials", "auth", false, { cause: err });
  if (status === 429) return new ProviderError("AI provider rate limited", "rate_limited", true, { cause: err });
  if (status !== undefined && status >= 500) return new ProviderError("AI provider unavailable", "unavailable", true, { cause: err });
  if (status !== undefined && status >= 400) return new ProviderError("AI provider rejected the request", "bad_request", false, { cause: err });
  return new ProviderError("AI provider call failed", "unknown", true, { cause: err });
}
