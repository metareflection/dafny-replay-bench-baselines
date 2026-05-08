import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runDafnyVerify, summarizeErrors } from "./dafny.js";
import { extractDiffs, applyDiffs } from "./patch.js";
import {
  SYSTEM_PROMPT,
  initialUserPrompt,
  feedbackUserPrompt,
} from "./prompts.js";
import { callModel, makeClient, type ChatTurn } from "./bedrock.js";

export interface IterationLog {
  index: number;
  userPromptChars: number;
  modelText: string;
  diffsExtracted: number;
  patchApplied: boolean;
  patchOutput: string;
  verifyOk: boolean;
  verifyDurationMs: number;
  verifierSummary: string;
  usage: unknown;
}

export interface FileResult {
  file: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  totalIterations: number;
  initiallyVerified: boolean;
  finalVerified: boolean;
  iterations: IterationLog[];
  finalVerifierSummary: string;
}

export interface RunOptions {
  benchDir: string;
  mode: "bodies_erased" | "helpers_removed";
  fileName: string;
  outputDir: string;
  model: string;
  maxIterations: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: boolean;
  dafnyTimeoutMs?: number;
}

export async function runOnFile(opts: RunOptions): Promise<FileResult> {
  const startedAt = new Date().toISOString();
  const sourcePath = join(opts.benchDir, opts.mode, opts.fileName);
  const workDir = join(opts.outputDir, opts.mode, basename(opts.fileName, ".dfy"));
  mkdirSync(workDir, { recursive: true });
  const workPath = join(workDir, opts.fileName);
  copyFileSync(sourcePath, workPath);

  const client = makeClient();

  // 0. Initial verification (likely fails for this benchmark, but check anyway).
  const initial = await runDafnyVerify(workPath, {
    timeoutMs: opts.dafnyTimeoutMs,
  });
  const initialSummary = summarizeErrors(initial);

  if (initial.ok) {
    return {
      file: opts.fileName,
      mode: opts.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalIterations: 0,
      initiallyVerified: true,
      finalVerified: true,
      iterations: [],
      finalVerifierSummary: initialSummary,
    };
  }

  const history: ChatTurn[] = [];
  const iterations: IterationLog[] = [];
  let lastVerifierSummary = initialSummary;
  let finalVerified = false;

  for (let i = 1; i <= opts.maxIterations; i++) {
    let userPrompt: string;
    if (i === 1) {
      userPrompt = initialUserPrompt({
        fileName: opts.fileName,
        fileContent: readFileSync(workPath, "utf8"),
        verifierOutput: lastVerifierSummary,
      });
    } else {
      const prev = iterations[iterations.length - 1];
      userPrompt = feedbackUserPrompt({
        patchOutput: prev.patchOutput,
        patchApplied: prev.patchApplied,
        verifierOutput: lastVerifierSummary,
      });
    }
    history.push({ role: "user", content: userPrompt });

    const call = await callModel({
      client,
      model: opts.model,
      system: SYSTEM_PROMPT,
      history,
      effort: opts.effort,
      thinking: opts.thinking,
    });
    history.push({ role: "assistant", content: call.text });

    const diffs = extractDiffs(call.text);
    const patch = await applyDiffs(workPath, diffs);

    let verifyOk = false;
    let verifyDurationMs = 0;
    let verifierSummary = "[patch did not apply; skipped verify]";
    if (patch.applied) {
      const v = await runDafnyVerify(workPath, {
        timeoutMs: opts.dafnyTimeoutMs,
      });
      verifyOk = v.ok;
      verifyDurationMs = v.durationMs;
      verifierSummary = summarizeErrors(v);
      lastVerifierSummary = verifierSummary;
    } else {
      // Don't update lastVerifierSummary; model retries from same state next iter.
    }

    iterations.push({
      index: i,
      userPromptChars: userPrompt.length,
      modelText: call.text,
      diffsExtracted: diffs.length,
      patchApplied: patch.applied,
      patchOutput: patch.rawOutput,
      verifyOk,
      verifyDurationMs,
      verifierSummary,
      usage: call.usage,
    });

    if (verifyOk) {
      finalVerified = true;
      break;
    }
  }

  const result: FileResult = {
    file: opts.fileName,
    mode: opts.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalIterations: iterations.length,
    initiallyVerified: false,
    finalVerified,
    iterations,
    finalVerifierSummary: lastVerifierSummary,
  };

  writeFileSync(
    join(workDir, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
