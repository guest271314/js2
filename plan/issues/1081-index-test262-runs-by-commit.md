---
id: 1081
title: "Index test262 runs by commit hash — enable merge-base comparisons without re-running"
status: done
completed: 2026-06-03
created: 2026-04-11
updated: 2026-06-03
priority: critical
feasibility: medium
reasoning_effort: medium
task_type: feature
language_feature: n/a
goal: ci-hardening
sprint: Backlog
parent: 1080
depends_on: [1076]
es_edition: n/a
---
# #1081 — Commit-hash-indexed test262 run cache

## Problem

Today the only "baseline" a PR can compare against is the singleton
`benchmarks/results/test262-current.jsonl` committed on main. That file
represents **a point in time**, not a specific commit — and when main drifts
between the last refresh and a PR's CI run, the PR compares against a state
that doesn't match any real commit in history.

Ideally a PR should compare against main **at the PR's merge-base commit**.
If we already ran test262 against that commit, we shouldn't need to re-run
— we should load the cached results. This eliminates drift attribution
entirely: "regressions introduced by your PR" is now precisely
`results(merge-base) → results(HEAD)`, a well-defined set.

## Design

### Storage layout

Each test262 run writes two artifacts keyed by the commit hash it was run
against:

```
benchmarks/runs/<commit-sha>.json   — summary (pass/fail/CE counts, run metadata)
benchmarks/runs/<commit-sha>.jsonl  — per-test results
```

When the `promote-baseline` job commits a refreshed baseline, it ALSO writes
`benchmarks/runs/<sha>.{json,jsonl}` as a side-file. The existing
`benchmarks/results/test262-current.jsonl` can stay as a human-readable
"latest" pointer for convenience, but the hash-indexed files are the
authoritative data.

Commit hash = the SHA of main at the time the sharded run was performed
(from `github.sha` in the workflow, or from `git rev-parse HEAD` on the
runner). Every entry in `runs/index.json` should reference its commit SHA.

### PR CI comparison logic

1. Determine the PR's merge-base: `git merge-base origin/main HEAD`
2. Look up `benchmarks/runs/<merge-base-sha>.jsonl`
   - **Cache hit**: load it as the baseline, diff against the PR's new
     results. Done — no wasted run.
   - **Cache miss**: fall back to the current logic (diff against
     `benchmarks/results/test262-current.jsonl`) and emit a warning
     in the CI output so we can track cache-miss frequency.
3. Optionally: a cache miss can trigger a background run to populate
   the missing entry for future PRs, with `workflow_dispatch` on a
   `test262-on-demand` helper workflow.

### Retention

Keeping every commit's artifacts forever is unnecessary. Retention policy:

- **Keep**: every merge commit on main for the last 30 days.
- **Keep**: every sprint-tagged commit (`sprint/<N>`) forever.
- **Evict**: intermediate baseline-refresh commits on main older than 7
  days.
- **Maximum total size cap**: 500 MB across all `benchmarks/runs/*.jsonl`
  files. Old entries evicted LRU when cap is reached.

Retention runs as a scheduled workflow (weekly) that prunes and commits
the cleanup.

### Storage size sanity check

Each `.jsonl` run file is ~1.5 MB (43k lines, ~35 bytes avg per entry).
Keeping ~150 commits at any time ≈ 225 MB. Well within the 500 MB cap.

If size becomes a concern:
- **Compression**: gzip the `.jsonl` files. ~75% size reduction typical.
- **Delta storage**: store only the diff against the parent commit's
  run, reconstitute on load. More complex but ~95% reduction in steady
  state.

### Schema

```json
// benchmarks/runs/<sha>.json
{
  "sha": "ef179253b...",
  "ref": "refs/heads/main",
  "pass": 21750,
  "fail": 18414,
  "compile_error": 1344,
  "skip": 1656,
  "total": 43164,
  "run_id": "24289351335",
  "run_started_at": "2026-04-11T17:55:12Z",
  "run_duration_seconds": 320,
  "test262_version": "<test262-submodule-sha>",
  "categories": {
    "language/statements/for-of": { "pass": 134, "fail": 12, "total": 146 },
    ...
  }
}
```

Having the per-category breakdown on disk enables fast diff queries
without loading the full 1.5 MB jsonl.

## Scope

1. Workflow changes: `promote-baseline` writes `benchmarks/runs/<sha>.{json,jsonl}`
   alongside the current `test262-current.*` files. One commit per main
   push, as today.
2. PR CI changes: new step `Load cached baseline for merge-base` that
   fetches `benchmarks/runs/<merge-base-sha>.jsonl` from main. If present,
   use it for the diff; if absent, use the current file.
3. `scripts/diff-test262.ts` already takes two JSONL files as input — no
   change needed.
4. Retention workflow (`test262-cache-prune.yml`) runs weekly.
5. `runs/index.json` references each commit SHA (already includes it per
   the existing trend graph logic).
6. Documentation: `benchmarks/runs/README.md` explains the layout and
   retention policy.

## Non-goals

- **Don't rewrite `diff-test262.ts`**: it already handles two arbitrary
  JSONL files.
- **Don't store PR-branch runs in this cache**: the cache is main-only.
  PR runs are ephemeral artifacts.
- **Don't require the cache for correctness**: a cache miss falls back
  to the existing behavior. The cache is a performance + drift-
  elimination enhancement.
- **Don't replace `test262-current.jsonl`**: keep it as a human-readable
  "latest main" pointer; the hash-indexed files are authoritative.

## Acceptance criteria

- [ ] `promote-baseline` writes `benchmarks/runs/<sha>.json` and
      `benchmarks/runs/<sha>.jsonl` on every successful refresh.
- [ ] PR CI loads the merge-base cache entry when present and uses it for
      the regression diff.
- [ ] Cache miss case logs a warning but does not fail.
- [ ] Retention workflow evicts old files under the 500 MB cap.
- [ ] A synthetic test: create a PR whose merge-base is an older cached
      commit; verify the PR CI diff uses the cached baseline, not the
      current one.
- [ ] Baseline comparison attribution is now drift-free: a PR's reported
      regressions are exactly those introduced by its commits, nothing
      inherited from main drift.

## Risks

- **Cache miss storms**: if every PR has a cache miss (because the main
  branch moves faster than the cache populates), we're back to the
  current drift problem. Mitigation: on cache miss, the background
  `test262-on-demand` workflow populates the missing entry so the next
  PR benefits. Accepts latency, avoids rot.
- **Disk pressure on the repo**: 225 MB of cached results is nontrivial.
  Mitigation: gzip compression, aggressive retention, LRU eviction at
  500 MB cap.
- **Cache corruption**: a bad run written to cache will mislead every
  subsequent PR that hits it. Mitigation: sanity-check each write (the
  existing `pass < 1000 OR total < 40000` check already does this in the
  workflow; extend to also reject against expected ranges).
- **Cache shadowing a real regression**: if the cache is stale (e.g.
  test262 submodule updated but cache wasn't regenerated), a PR could
  appear clean against an obsolete baseline. Mitigation: include
  `test262_version` in the cache key — a cache entry is only valid if
  `test262_version` matches HEAD's.

## Relationship

- Parent: **#1080** umbrella (CI baseline-drift gate fix).
- Depends on: **#1076** (split merge job so main always refreshes — cache
  is pointless if refreshes don't happen).
- Related: **#1077** (fresh baseline fetch at runtime) — this issue is
  the ideal version of #1077 where "fresh" means "at the merge-base
  specifically", not just "latest main". If #1081 lands, #1077 becomes
  redundant and can be closed.

## Notes

- This is the elegant fix. The other umbrella fixes (#1076-#1079) are
  tactical defense; #1081 is the strategic one.
- The architecture also enables retroactive bisect: if a regression is
  detected on main weeks later, we can compare any two cached runs to
  pinpoint exactly which merge introduced it, without re-running test262
  on historical commits.
- Every PR that touches code but isn't the merge-base itself benefits
  from this cache automatically — no dev workflow changes required.

## Implementation note — 2026-06-03

Shipped as three pure, unit-tested Node helpers plus workflow wiring; the
cache physically lives in the `loopdive/js2wasm-baselines` repo (out of the
main repo to avoid clone bloat), consistent with the existing baseline-JSONL
split (#1528).

- `scripts/write-run-cache.mjs` — builds `runs/<sha>.json` (summary + per-
  category breakdown + `test262_version`) and copies `runs/<sha>.jsonl`.
  Declines corrupt reports (pass < 1000 or total < 40000). Called from the
  `promote-baseline` job after the `runs/index.json` update.
- `scripts/resolve-merge-base-baseline.mjs` — in the PR `regression-gate` job,
  computes `git merge-base origin/main HEAD`, and on a cache hit (entry exists
  AND its `test262_version` matches the PR's submodule) overwrites
  `benchmarks/results/test262-current.jsonl` with the merge-base's exact
  results. A miss warns (`::warning::#1081 … MISS`) and keeps the latest-main
  baseline — never fails the build. The `regression-gate` checkout was changed
  to `fetch-depth: 0` + `submodules: recursive` so merge-base + test262 version
  are resolvable.
- `scripts/prune-run-cache.mjs` + `.github/workflows/test262-cache-prune.yml`
  — weekly retention: sprint-tagged SHAs (derived from `sprint/*` /
  `sprint-*/begin` tags) kept forever; non-tagged entries older than 30 days
  evicted; LRU eviction once total exceeds the 500 MB cap.
- `benchmarks/runs/README.md` documents the layout, schema, flow, and policy.
- Unit tests: `tests/issue-1081.test.ts` (11 tests, green) cover summary build,
  corrupt-report rejection, cache hit/miss/version-mismatch, and the eviction
  planner (age, sprint-pin immunity, LRU cap). End-to-end smoke of all three
  scripts against a synthetic baselines dir confirmed hit/miss/prune behavior.

`diff-test262.ts` was left untouched (it already takes two arbitrary JSONL
files — per the non-goals). #1077 is now redundant per the issue's Relationship
section and can be closed separately.
