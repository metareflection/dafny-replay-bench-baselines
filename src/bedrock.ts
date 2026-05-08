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

export async function callModel(args: {
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
    ...(args.thinking ? { thinking: { type: "adaptive" } } : {}),
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
