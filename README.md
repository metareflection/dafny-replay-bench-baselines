# dafny-replay-bench-baselines

Baselines for the [dafny-replay-bench](https://github.com/metareflection/dafny-replay-bench) benchmark.

The first baseline (`src/`) drives Claude Opus 4.7 on AWS Bedrock through up to N iterations of `dafny verify` → unified-diff feedback per file. Patches are applied via `patch(1) --fuzz=3`, so minor context drift is tolerated.

## Setup

```bash
npm install
cp .env.example .env   # edit if needed
```

Requirements:
- Node 20+
- `dafny` on PATH (4.x)
- AWS credentials with Bedrock access in `AWS_REGION` (default `us-east-1`)
- Bedrock inference profile access for `us.anthropic.claude-opus-4-7`

## Run

Smoke test on a couple of files:

```bash
npm run run -- --mode bodies_erased --file Authority.dfy --file Replay.dfy
```

Full sweep over a mode:

```bash
npm run run -- --mode bodies_erased --all
npm run run -- --mode helpers_removed --all --concurrency 4
```

Common flags (see `--help`):
- `--iterations N` — max LLM-feedback iterations per file (default 3)
- `--effort low|medium|high|xhigh|max` — Opus 4.7 effort (default `xhigh`)
- `--no-thinking` — disable adaptive thinking
- `--concurrency N` — files in flight at once
- `--model` / `--bench-dir` / `--output-dir` — overrides

## Output

Per file: `results/<mode>/<basename>/result.json` plus the patched `.dfy` (so you can inspect what the model produced and whether it verifies).

Per run: `results/summary-<mode>-<timestamp>.json` with one row per file.

## Notes

- The runner copies each input file into the output workspace before patching — the source benchmark dir is never modified.
- `dafny verify` exit codes: `0` = verified, `4` = errors, other = environment issue. Stdout is captured into the next prompt.
- Failed patches do not advance the verify state; the model is told its diff didn't apply and gets another shot within the iteration budget.
