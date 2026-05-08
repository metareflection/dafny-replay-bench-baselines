import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgentOnFile, type AgentFileResult } from "./runner.js";

interface CliArgs {
  mode: "bodies_erased" | "helpers_removed";
  files: string[];
  benchDir: string;
  outputDir: string;
  model: string;
  maxTurns: number;
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> & { files?: string[] } = {
    mode: "bodies_erased",
    maxTurns: 30,
    concurrency: 1,
  };
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--mode":
        args.mode = next() as CliArgs["mode"];
        break;
      case "--file":
        files.push(next());
        break;
      case "--bench-dir":
        args.benchDir = next();
        break;
      case "--output-dir":
        args.outputDir = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--max-turns":
        args.maxTurns = Number(next());
        break;
      case "--concurrency":
        args.concurrency = Number(next());
        break;
      case "--all":
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (a.endsWith(".dfy")) files.push(a);
        else {
          console.error(`Unknown arg: ${a}`);
          process.exit(2);
        }
    }
  }
  args.files = files;
  args.benchDir = resolve(
    args.benchDir ?? process.env.BENCH_DIR ?? "../dafny-replay-bench",
  );
  args.outputDir = resolve(args.outputDir ?? "results-agent");
  args.model =
    args.model ??
    process.env.BEDROCK_MODEL_ID ??
    "us.anthropic.claude-opus-4-7";
  return args as CliArgs;
}

function printHelp(): void {
  console.error(`Usage: tsx src-agent/index.ts [options] [<files...>]

Options:
  --mode <bodies_erased|helpers_removed>   default: bodies_erased
  --file <name.dfy>                        specific file (repeatable)
  --bench-dir <path>                       default: env BENCH_DIR or ../dafny-replay-bench
  --output-dir <path>                      default: ./results-agent
  --model <bedrock-model-id>               default: us.anthropic.claude-opus-4-7
  --max-turns <n>                          agent turn cap per file (default 30)
  --concurrency <n>                        files in flight at once (default 1)
  --all                                    run on every .dfy file in the mode dir
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let files = args.files;
  if (files.length === 0) {
    files = readdirSync(join(args.benchDir, args.mode))
      .filter((f) => f.endsWith(".dfy"))
      .sort();
  }
  console.error(
    `[run-agent] mode=${args.mode} model=${args.model} maxTurns=${args.maxTurns} files=${files.length} concurrency=${args.concurrency}`,
  );

  mkdirSync(args.outputDir, { recursive: true });
  const summary: Array<Pick<
    AgentFileResult,
    "file" | "mode" | "turnsUsed" | "finalVerified" | "totalCostUsd"
  >> = [];

  const queue = [...files];
  const workers = Array.from(
    { length: Math.max(1, args.concurrency) },
    async () => {
      while (queue.length > 0) {
        const f = queue.shift();
        if (!f) break;
        const t0 = Date.now();
        console.error(`[start] ${f}`);
        try {
          const r = await runAgentOnFile({
            benchDir: args.benchDir,
            mode: args.mode,
            fileName: f,
            outputDir: args.outputDir,
            model: args.model,
            maxTurns: args.maxTurns,
          });
          const tag = r.finalVerified ? "OK" : "FAIL";
          console.error(
            `[${tag}] ${f} (turns=${r.turnsUsed}, $${r.totalCostUsd.toFixed(3)}, ${Date.now() - t0}ms)`,
          );
          summary.push({
            file: r.file,
            mode: r.mode,
            turnsUsed: r.turnsUsed,
            finalVerified: r.finalVerified,
            totalCostUsd: r.totalCostUsd,
          });
        } catch (err: any) {
          console.error(`[ERR] ${f}: ${err.message ?? err}`);
          summary.push({
            file: f,
            mode: args.mode,
            turnsUsed: 0,
            finalVerified: false,
            totalCostUsd: 0,
          });
        }
      }
    },
  );
  await Promise.all(workers);

  writeFileSync(
    join(args.outputDir, `summary-${args.mode}-${Date.now()}.json`),
    JSON.stringify(summary, null, 2),
  );
  const ok = summary.filter((s) => s.finalVerified).length;
  console.error(`[done] verified ${ok}/${summary.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
