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
  // Setting `timeout` at the client level bypasses the SDK's max_tokens
  // heuristic that otherwise refuses non-streaming requests when it estimates
  // the response could exceed 10 minutes. We need long-form non-streaming
  // because Bedrock's SSE drops idle streams during long adaptive thinking.
  return new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    timeout: 30 * 60 * 1000, // 30 min
  });
}

function isRetryableStreamError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  const name = err instanceof Error ? err.name : "";
  // undici / Bedrock-side mid-stream drops, our own AbortController timeouts,
  // and a few standard transient codes.
  if (name === "AbortError" || /aborted/i.test(msg)) return true;
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
  timeoutMs?: number;
}): Promise<CallResult> {
  // Non-streaming on purpose. We have no need for token-by-token output (we
  // wait for the final message and parse SEARCH/REPLACE blocks), and SSE on
  // Bedrock proved fragile when adaptive thinking idles the stream for many
  // minutes.
  //
  // We enforce the timeout via AbortController instead of relying solely on
  // the SDK's `timeout` option: when AWS's load balancer silently drops the
  // underlying TCP connection during a long thinking response, undici has
  // been observed to leave the request promise in limbo (no error, no
  // resolution). The AbortController-driven timeout guarantees we fail and
  // can retry instead of hanging forever.
  const timeoutMs = args.timeoutMs ?? 10 * 60 * 1000; // 10 min
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let message;
  try {
    message = await args.client.messages.create(
      {
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
        ...(args.thinking ? { thinking: { type: "adaptive" } } : {}),
        ...(args.effort
          ? { output_config: { effort: args.effort } as any }
          : {}),
      } as any,
      { timeout: timeoutMs, signal: ac.signal } as any,
    );
  } finally {
    clearTimeout(timer);
  }
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
  timeoutMs?: number;
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
