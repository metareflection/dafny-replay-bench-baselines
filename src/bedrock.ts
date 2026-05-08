import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

export interface CallResult {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stopReason: string | null;
  raw: unknown;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export function makeClient(): AnthropicBedrock {
  return new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
  });
}

function isRetryableStreamError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  // undici / Bedrock-side mid-stream drops + a few standard transient codes.
  return /terminated|ECONNRESET|EPIPE|socket hang up|ETIMEDOUT|fetch failed|network error/i.test(
    msg,
  );
}

async function callModelOnce(args: {
  client: AnthropicBedrock;
  model: string;
  system: string;
  history: ChatTurn[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: boolean;
}): Promise<CallResult> {
  const stream = await args.client.messages.stream({
    model: args.model,
    max_tokens: args.maxTokens ?? 64000,
    system: [
      {
        type: "text",
        text: args.system,
        cache_control: { type: "ephemeral" },
      },
    ] as any,
    messages: args.history.map((t) => ({
      role: t.role,
      content: [{ type: "text", text: t.content }],
    })) as any,
    // `display: "summarized"` keeps the SSE stream non-idle during long
    // adaptive thinking, which avoids `terminated` mid-stream drops on
    // Bedrock when the model thinks for several minutes.
    ...(args.thinking
      ? { thinking: { type: "adaptive", display: "summarized" } }
      : {}),
    ...(args.effort
      ? { output_config: { effort: args.effort } as any }
      : {}),
  } as any);

  const message = await stream.finalMessage();
  const text = message.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  return {
    text,
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_read_input_tokens: (message.usage as any).cache_read_input_tokens,
      cache_creation_input_tokens: (message.usage as any)
        .cache_creation_input_tokens,
    },
    stopReason: message.stop_reason ?? null,
    raw: message,
  };
}

export async function callModel(args: {
  client: AnthropicBedrock;
  model: string;
  system: string;
  history: ChatTurn[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: boolean;
  maxAttempts?: number;
}): Promise<CallResult> {
  const maxAttempts = args.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callModelOnce(args);
    } catch (err) {
      lastErr = err;
      if (!isRetryableStreamError(err) || attempt === maxAttempts) {
        throw err;
      }
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.error(
        `[callModel] attempt ${attempt} failed (${(err as Error).message}); retrying in ${backoffMs}ms`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}
