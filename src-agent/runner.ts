// Agent SDK baseline. Lets Claude drive Edit + Bash itself instead of the
// SEARCH/REPLACE-block loop in ../src. Each turn is short, so neither SSE
// drops nor 30-min request timeouts can kill a whole run.
//
// Permissions are locked down: dontAsk + an explicit allowlist that includes
// only `dafny verify <args>` for shell, plus Read/Edit/Write scoped naturally
// by cwd (the per-file workdir).
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { runDafnyVerify, summarizeErrors } from "../src/dafny.js";

// Route the SDK through Bedrock with the same AWS creds the original
// baseline uses. Set before the first query() call.
process.env.CLAUDE_CODE_USE_BEDROCK = "1";
process.env.AWS_REGION ??= "us-east-1";

export interface AgentRunOptions {
  benchDir: string;
  mode: "bodies_erased" | "helpers_removed";
  fileName: string;
  outputDir: string;
  model?: string;
  maxTurns?: number;
}

export interface AgentFileResult {
  file: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  sessionId?: string;
  turnsUsed: number;
  totalCostUsd: number;
  finalVerified: boolean;
  finalVerifierSummary: string;
  modelResultText: string;
  stopReason?: string;
  agentError?: string;
  transcript: unknown[];
}

const SYSTEM_PROMPT = `You are repairing a Dafny file so it verifies.

The current working directory contains exactly one .dfy file. Your job:

1. Read the .dfy file.
2. Run \`dafny verify <file>.dfy\` to see verification errors.
3. Edit the file to fix errors. You may fill in method/function bodies and
   add helper lemmas, ghost variables, invariants, decreases clauses on
   loops, and assertions.
4. Re-run \`dafny verify\` and iterate until it exits 0.

Hard rules:
- DO NOT change method signatures, requires/ensures clauses, type
  definitions, or any part of the public API. Only fill in or strengthen
  bodies and add new helper lemmas/ghost code.
- The only shell command available to you is \`dafny verify ...\`. Other
  commands will be denied.
- Stop as soon as \`dafny verify\` exits 0. Briefly report success.
- If you cannot make it verify within the turn budget, stop and explain
  what's blocking you.`;

export async function runAgentOnFile(
  opts: AgentRunOptions,
): Promise<AgentFileResult> {
  const startedAt = new Date().toISOString();
  const sourcePath = join(opts.benchDir, opts.mode, opts.fileName);
  const workDir = join(
    opts.outputDir,
    opts.mode,
    basename(opts.fileName, ".dfy"),
  );
  mkdirSync(workDir, { recursive: true });
  copyFileSync(sourcePath, join(workDir, opts.fileName));

  const transcript: unknown[] = [];
  let sessionId: string | undefined;
  let resultText = "";
  let totalCostUsd = 0;
  let turnsUsed = 0;
  let stopReason: string | undefined;
  let agentError: string | undefined;

  try {
    for await (const msg of query({
      prompt: `Make ${opts.fileName} verify with \`dafny verify\`.`,
      options: {
        model: opts.model ?? "us.anthropic.claude-opus-4-7",
        systemPrompt: SYSTEM_PROMPT,
        cwd: workDir,
        permissionMode: "dontAsk",
        allowedTools: [
          "Read",
          "Edit",
          "Write",
          "Bash(dafny verify *)",
        ],
        settingSources: [],
        maxTurns: opts.maxTurns ?? 30,
      },
    })) {
      transcript.push(msg);
      const m = msg as any;
      if (m.type === "system" && m.subtype === "init") {
        sessionId = m.session_id;
      }
      if (m.type === "assistant") turnsUsed++;
      if (m.type === "result") {
        resultText = m.result ?? "";
        totalCostUsd = m.total_cost_usd ?? 0;
        stopReason = m.subtype;
      }
    }
  } catch (err: any) {
    // The SDK throws on conditions like max-turns reached. Capture the
    // message and fall through so we still re-verify and write result.json.
    agentError = err?.message ?? String(err);
    if (!stopReason) stopReason = "agent_error";
  }

  const v = await runDafnyVerify(join(workDir, opts.fileName), {});
  const finalVerified = v.ok;
  const finalVerifierSummary = summarizeErrors(v);

  const result: AgentFileResult = {
    file: opts.fileName,
    mode: opts.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    sessionId,
    turnsUsed,
    totalCostUsd,
    finalVerified,
    finalVerifierSummary,
    modelResultText: resultText,
    stopReason,
    agentError,
    transcript,
  };
  writeFileSync(
    join(workDir, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
