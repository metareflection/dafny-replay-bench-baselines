import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

export interface PatchResult {
  applied: boolean;
  rawOutput: string;
  fuzz: number;
  hadRejects: boolean;
  diffsTried: number;
}

const DIFF_FENCE_RE = /```(?:diff|patch)?\s*\n([\s\S]*?)```/g;

export function extractDiffs(text: string): string[] {
  const diffs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = DIFF_FENCE_RE.exec(text)) !== null) {
    const body = m[1];
    if (/^(?:---|@@)/m.test(body)) diffs.push(body);
  }
  if (diffs.length === 0) {
    const idx = text.indexOf("--- ");
    if (idx >= 0 && /\n@@ /.test(text.slice(idx))) {
      diffs.push(text.slice(idx));
    }
  }
  return diffs;
}

export async function applyDiff(
  filePath: string,
  diff: string,
): Promise<PatchResult> {
  const tmp = mkdtempSync(join(tmpdir(), "dafny-baseline-"));
  const diffPath = join(tmp, "patch.diff");
  const normalized = normalizeDiffPaths(diff, basename(filePath));
  writeFileSync(diffPath, normalized);

  try {
    return await runPatch(filePath, diffPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function normalizeDiffPaths(diff: string, baseName: string): string {
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("--- ")) lines[i] = `--- ${baseName}`;
    else if (lines[i].startsWith("+++ ")) lines[i] = `+++ ${baseName}`;
  }
  if (!diff.endsWith("\n")) lines.push("");
  return lines.join("\n");
}

function runPatch(
  filePath: string,
  diffPath: string,
): Promise<PatchResult> {
  return new Promise((resolve) => {
    const args = [
      "-p0",
      "--no-backup-if-mismatch",
      "--forward",
      "--fuzz=3",
      filePath,
      diffPath,
    ];
    const child = spawn("patch", args, {
      cwd: dirname(filePath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      const hadRejects = /reject/i.test(out) || code !== 0;
      const fuzzMatch = out.match(/with fuzz (\d+)/);
      resolve({
        applied: code === 0,
        rawOutput: out,
        fuzz: fuzzMatch ? Number(fuzzMatch[1]) : 0,
        hadRejects,
        diffsTried: 1,
      });
    });
    child.on("error", (err) => {
      resolve({
        applied: false,
        rawOutput: `[spawn error] ${err.message}`,
        fuzz: 0,
        hadRejects: true,
        diffsTried: 1,
      });
    });
  });
}

export async function applyDiffs(
  filePath: string,
  diffs: string[],
): Promise<PatchResult> {
  if (diffs.length === 0) {
    return {
      applied: false,
      rawOutput: "[no diff blocks found in model output]",
      fuzz: 0,
      hadRejects: false,
      diffsTried: 0,
    };
  }
  const outputs: string[] = [];
  let totalFuzz = 0;
  let anyRejects = false;
  for (const d of diffs) {
    const r = await applyDiff(filePath, d);
    outputs.push(r.rawOutput);
    totalFuzz += r.fuzz;
    if (r.hadRejects) anyRejects = true;
    if (!r.applied) {
      return {
        applied: false,
        rawOutput: outputs.join("\n---\n"),
        fuzz: totalFuzz,
        hadRejects: true,
        diffsTried: diffs.length,
      };
    }
  }
  return {
    applied: true,
    rawOutput: outputs.join("\n---\n"),
    fuzz: totalFuzz,
    hadRejects: anyRejects,
    diffsTried: diffs.length,
  };
}
