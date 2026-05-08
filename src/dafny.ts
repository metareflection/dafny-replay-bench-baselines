import { spawn } from "node:child_process";

export interface DafnyResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export async function runDafnyVerify(
  filePath: string,
  opts: { dafnyBin?: string; timeoutMs?: number } = {},
): Promise<DafnyResult> {
  const dafnyBin = opts.dafnyBin ?? process.env.DAFNY_BIN ?? "dafny";
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.DAFNY_TIMEOUT_MS ?? 180_000);

  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(dafnyBin, ["verify", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}

// Count {:axiom}-attributed declarations in a Dafny source. The {:axiom}
// attribute is Dafny's way to mark a deliberate trusted assumption — it
// suppresses the default --allow-axioms warning, so `assume {:axiom} false`
// or `lemma {:axiom} Foo` slip past `dafny verify` silently. Files with any
// {:axiom} attribute must not count as solved.
//
// Bare `assume P;` (no attribute) is already caught by Dafny's default
// --allow-axioms=False warning, which fails verification, so it doesn't
// need a separate check.
export function countAxiomAttributes(src: string): number {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return (stripped.match(/\{\s*:\s*axiom\b/g) ?? []).length;
}

export function summarizeErrors(result: DafnyResult): string {
  if (result.timedOut) {
    return `Dafny timed out after ${result.durationMs} ms.`;
  }
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  const tailMatch = out.match(/Dafny program verifier finished with .*$/m);
  const tail = tailMatch ? tailMatch[0] : "";
  const combined = [out, err].filter(Boolean).join("\n");
  return tail ? `${combined}\n[summary] ${tail}` : combined;
}
