---
id: 1522
title: "Race local test262 (Claude Code on Web) vs. GitHub Actions, cancel CI if local wins the queue"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
goal: ci-cost-reduction
depends_on: []
---
# #1522 — Race local test262 vs. CI, cancel the loser

## Problem

When an agent running in Claude Code on Web opens a PR, the GitHub Actions `Test262 Sharded` workflow is the gate that feeds `.claude/ci-status/pr-<N>.json` and unblocks `dev-self-merge`. Measured baseline of this container (2026-05-20):

- **16 GB RAM, 0 swap, 4 cores** (Intel Xeon @ 2.80GHz, no SMT siblings)
- **Peak usage with `COMPILER_POOL_SIZE=4`**: ~2.8 GB used / ~13 GB available (~80% headroom)
- Full test262 finished locally in ~17 min wall-clock (vs. CI ~queue + shards)

The CI shards exist mostly to amortize the per-runner cold start across many runners; once we have one warm container with all 4 cores busy, a single local run is competitive with sharded CI on a small PR, and cheaper (no Actions minutes).

## Proposal

When an agent opens a PR from a web session, run test262 locally **in parallel with** the workflow being queued. If the local run finishes while the GH workflow is still in the `queued` state, cancel the workflow run and publish the local results to the PR. If CI has already transitioned to `in_progress` by the time local finishes, keep CI as the authority and discard the local result.

This is a "first to start wins" race, not "first to finish wins" — once Actions minutes are committed, there's no point cancelling.

## Acceptance criteria

1. New script `scripts/race-test262-vs-ci.sh` (or similar) that:
   - Detects "Claude Code on Web" environment (env var TBD — e.g. `CLAUDE_CODE_REMOTE`, or check for a marker the container sets)
   - Kicks off `COMPILER_POOL_SIZE=4 pnpm run test:262` in background
   - Polls the GH MCP tools (or `gh api` if available) for the PR's `Test262 Sharded` workflow status every ~15s
   - On local completion: if CI status is still `queued`, cancel the workflow run and publish results; if `in_progress`/`completed`, discard local and wait for CI
2. Local results path must produce the **same JSON shape** the dev-self-merge skill currently consumes from `.claude/ci-status/pr-<N>.json`, including `net_per_test`, bucket-by-path regression analysis, and SHA-matching.
3. Publication path: write the structured result as a PR comment whose body starts with a marker like `<!-- test262-results -->` so the dev-self-merge skill can find it without a workflow-level write to the file (the file is owned by a CI workflow on main).
4. Trust validation: before this is enabled by default, run **5 PRs in shadow mode** (local runs but doesn't cancel CI). Compare local vs. CI pass/fail per-test on the same SHA. Acceptable: identical pass/fail. If any test flips, document why (timing? OOM? worker count?) and gate appropriately.
5. Bail-out paths:
   - If local run OOMs or fails to start, let CI proceed normally (no harm done)
   - If GH API for the workflow status is unreachable for >2 min, abort local and let CI run
   - If the PR diff touches the test262 runner itself (`tests/test262-*.ts`, `scripts/run-test262-vitest.sh`), force CI regardless — these changes need the sharded validation

## Open questions

- **Authority transfer**: is a PR comment good enough, or do we want the local runner to write to `.claude/ci-status/pr-<N>.json` via a `workflow_dispatch` callback on main? Comment is simpler; file write is more uniform with existing flow.
- **Cancellation auth**: the available `mcp__github__*` tools don't include an explicit "cancel workflow run". We'd need `mcp__github__workflow_run_cancel` (check if it exists) or fall back to disabling the workflow trigger on a label, etc.
- **Baseline freshness**: the committed `benchmarks/results/test262-current.jsonl` (~15MB) must be in the worktree. CI fetches a separate baseline from `loopdive/js2wasm-baselines` — should local match that fetch, or trust the committed copy? Probably fetch, to match CI.
- **One container, many PRs**: if two PRs are opened back-to-back, the local runner's flock prevents parallel runs. PR2 will queue locally and likely lose its race. That's acceptable for now (CI handles it), but worth documenting.

## Notes from baseline run (2026-05-20)

This issue was prompted by a baseline measurement of the cloud container during a 4-wide `COMPILER_POOL_SIZE=4` test262 run. Numbers above are from that run; see git history of this branch for the actual `benchmarks/results/test262-results-*.jsonl`.
