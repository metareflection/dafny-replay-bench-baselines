import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  countAxiomAttributes,
  runDafnyVerify,
  summarizeErrors,
} from "./dafny.js";
import { extractEdits, applyEdits } from "./patch.js";
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
  editsExtracted: number;
  patchApplied: boolean;
  patchOutput: string;
  verifyOk: boolean;
  axiomCount: number;
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
  dafnyExitOk: boolean;
  axiomCount: number;
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
  // Optional extra system-prompt content appended after the base prompt.
  // Loaded by the CLI from --extra-prompt <path>; empty when not provided.
  extraSystemPrompt?: string;
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
    const initialAxioms = countAxiomAttributes(readFileSync(workPath, "utf8"));
    const earlyResult: FileResult = {
      file: opts.fileName,
      mode: opts.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalIterations: 0,
      initiallyVerified: true,
      finalVerified: initialAxioms === 0,
      dafnyExitOk: true,
      axiomCount: initialAxioms,
      iterations: [],
      finalVerifierSummary:
        initialAxioms > 0
          ? `${initialSummary}\n[rejected] ${initialAxioms} {:axiom} attribute(s) in input file; not counted as solved.`
          : initialSummary,
    };
    writeFileSync(
      join(workDir, "result.json"),
      JSON.stringify(earlyResult, null, 2),
    );
    return earlyResult;
  }

  const extra = opts.extraSystemPrompt?.trim();
  const systemPrompt = extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT;

  const history: ChatTurn[] = [];
  const iterations: IterationLog[] = [];
  let lastVerifierSummary = initialSummary;
  let finalVerified = false;
  let lastDafnyExitOk = false;
  let lastAxiomCount = 0;

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
      system: systemPrompt,
      history,
      effort: opts.effort,
      thinking: opts.thinking,
    });
    // The Bedrock API rejects empty text content blocks. If the model
    // returned no text (e.g., ran out of output budget mid-thinking), replace
    // with a non-empty sentinel so subsequent iterations don't 400.
    const assistantContent =
      call.text.trim().length > 0
        ? call.text
        : "[no text content returned — model produced only thinking blocks or hit max_tokens during thinking]";
    history.push({ role: "assistant", content: assistantContent });

    const diffs = extractEdits(call.text);
    const patch = await applyEdits(workPath, diffs);

    let verifyOk = false;
    let axiomCount = 0;
    let verifyDurationMs = 0;
    let verifierSummary = "[patch did not apply; skipped verify]";
    if (patch.applied) {
      const v = await runDafnyVerify(workPath, {
        timeoutMs: opts.dafnyTimeoutMs,
      });
      verifyOk = v.ok;
      verifyDurationMs = v.durationMs;
      axiomCount = countAxiomAttributes(readFileSync(workPath, "utf8"));
      const baseSummary = summarizeErrors(v);
      verifierSummary =
        verifyOk && axiomCount > 0
          ? `${baseSummary}\n[rejected] ${axiomCount} {:axiom} attribute(s) remain in the patched file; not counted as solved. Replace each with a real proof.`
          : baseSummary;
      lastVerifierSummary = verifierSummary;
      lastDafnyExitOk = verifyOk;
      lastAxiomCount = axiomCount;
    } else {
      // Don't update lastVerifierSummary; model retries from same state next iter.
    }

    iterations.push({
      index: i,
      userPromptChars: userPrompt.length,
      modelText: call.text,
      editsExtracted: diffs.length,
      patchApplied: patch.applied,
      patchOutput: patch.rawOutput,
      verifyOk,
      axiomCount,
      verifyDurationMs,
      verifierSummary,
      usage: call.usage,
    });

    if (verifyOk && axiomCount === 0) {
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
    dafnyExitOk: lastDafnyExitOk,
    axiomCount: lastAxiomCount,
    iterations,
    finalVerifierSummary: lastVerifierSummary,
  };

  writeFileSync(
    join(workDir, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
