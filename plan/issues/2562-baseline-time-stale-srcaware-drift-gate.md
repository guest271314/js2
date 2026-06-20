---
id: 2562
title: "Baseline goes time-stale during docs/CI-only merge stretches → drift gate over-reacts (permanent fix)"
status: done
created: 2026-06-20
updated: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: hard
reasoning_effort: max
goal: ci-hardening
sprint: Backlog
assignee: ttraenkler/sd-baseline
---

# #2562 — Baseline time-staleness → drift gate over-reacts (permanent fix)

## Problem

The test262 baseline (`loopdive/js2wasm-baselines` `test262-current.jsonl`) only
re-promotes on **test262-relevant (src)** merges, via the `promote-baseline` job
in `test262-sharded.yml` (its `push:` trigger has a `paths:` filter restricted
to src/config). During a stretch of **docs/CI-only merges** (0 src files — e.g.
#1769/#1799/#1800 on 2026-06-20) main advances but the baseline does **not**
re-promote, so it goes **clock-time stale** (observed 2.5h) — even though src is
unchanged, so the comparison is still **content-valid**.

Two gates then over-reacted on **clock time**, failing otherwise net-positive
PRs (#1742 net +8, #1711):

1. The **time-based drift WARNING** (#1235) fires whenever the baseline JSONL is
   ≥30 _minutes_ older than main HEAD — a pure clock signal that says nothing
   about whether src changed.
2. The **10% regression-RATIO gate** (#1943, in `diff-test262.ts`) counts a
   single residual drift/flake regression that survives the `wasm_sha` filter
   against few improvements: 1/9 = 11.1% ≥ 10% → **GATE FAIL** on a +8 PR.

`refresh-baseline.yml` was `workflow_dispatch`-only (no cron), so nothing
re-promoted the baseline during a non-src stretch. Not a broken pipeline — a
coverage gap plus a clock-time over-reaction.

## Fix (two parts)

### Part 1 — Scheduled NORMAL refresh (anti-staleness)

`refresh-baseline.yml` (renamed _Baseline Refresh (scheduled + emergency)_) gets
a `schedule:` cron (`17 */8 * * *` — every 8h, offset from the :23/:37 baseline
crons) plus a **non-emergency NORMAL mode**:

- A run is **FORCED** (emergency, ignores the regression gate) **only** on a
  confirmed `workflow_dispatch` (`force_baseline_refresh=true` +
  `confirm_force="YES"`). The workflow-level `IS_FORCED` env encodes this once.
- A `schedule` run (or a non-forced manual dispatch) is a **NORMAL** refresh:
  it records main's **actual current** test262 state. This is **not** a
  force-promote — main is already-merged code, so recording its true
  conformance can never silently bake a regression past a PR gate. The
  `validate-inputs` job only requires the `"YES"` confirmation on the forced
  path; schedule/non-forced runs pass without it.
- The baselines-repo commit subject now records the **main-sha**
  (`... pass (<github.sha>)`), matching the `promote-baseline` format, and the
  report build passes `--baseline-sha`. This is load-bearing for Part 2: the
  #1668 stale-baseline guard and the new #2562 src-aware step both parse the
  main commit from that subject. Without it a refreshed baseline could not be
  proven content-current.

### Part 2 — Src-aware drift gate

In `test262-sharded.yml`'s `regression-gate` job, the _Check baseline staleness_
step now measures staleness by the count of **test262-relevant (src) commits**
between the baseline's recorded main-sha and `origin/main` (via
`scripts/test262-paths-match.sh`, the same filter the #1668 guard uses), not by
clock minutes:

- `src_commits_behind == 0` → baseline is **content-current**: suppress the
  time-based drift warning, and pass `--baseline-content-current` to
  `diff-test262.ts`.
- `src_commits_behind  > 0` → genuinely behind src: keep the drift warning and
  the strict gate.

`evaluateRegressionThresholds` (`scripts/diff-test262.ts`) gains a
`baselineContentCurrent` parameter. When set, the **ratio** gate is **waived
only** for a **net-positive** diff with **≤ `RATIO_WAIVE_MAX_REGRESSIONS` (3)**
absolute regressions — exactly the drift/flake over-reaction case. The waiver is
tightly bounded and **never** touches:

- the **bucket gate** (>50 regressions in one path), or
- the **net<0 gate** (caller-side `net_per_test < 0`).

So a real regression cluster, or any net-negative change, still fails the gate
regardless of content-currency. The waiver only neutralises the ratio's
punishment of low-improvement _net-positive_ PRs when the baseline genuinely
reflects current src.

## Why this is safe (regression-gate is load-bearing)

The gate that every merge depends on keeps its full power to catch **real**
regressions. The only behaviour change is: when the workflow can _prove_ the
baseline content is current (0 src commits behind), a tiny net-positive
drift/flake residue no longer trips the _ratio_ sub-gate. The proof is
conservative — any failure to parse/reach the baseline main-sha disables the
waiver (gate stays strict). Validated by unit tests _and_ end-to-end CLI runs:

- 1 regression / 9 improvements, content-current → **waived** (exit 0); strict
  (no flag) → **fails** (exit 1). [the exact #1742/#1711 case]
- 5 regressions / 2 improvements (net-negative), content-current → **fails**
  (net<0 AND ratio both fire).
- 60 regressions in one bucket, content-current → **fails** (bucket gate fires).

## Files changed

- `scripts/diff-test262.ts` — `RATIO_WAIVE_MAX_REGRESSIONS` const,
  `baselineContentCurrent` param on `evaluateRegressionThresholds`,
  `--baseline-content-current` CLI flag.
- `tests/issue-1943.test.ts` — `#2562` waiver test block (waive case, plus the
  net-negative / over-count / bucket-cluster safety boundaries).
- `.github/workflows/test262-sharded.yml` — src-aware staleness step
  (`baseline_content_current` / `src_commits_behind` outputs), pass the flag to
  the diff, src-aware drift footer.
- `.github/workflows/refresh-baseline.yml` — `schedule` cron + NORMAL mode,
  `IS_FORCED` env, conditional confirmation, main-sha in commit subjects,
  `--baseline-sha` on report build.

## Acceptance criteria

- [x] A scheduled (cron) NORMAL baseline refresh exists and records main's
      actual current state (not force/emergency).
- [x] The drift warning + ratio waiver are driven by **src-commit count**, not
      clock time; 0 src-behind ⇒ content-current ⇒ no time-based over-reaction.
- [x] Real regressions (net<0, large clusters, >3 absolute regressions) still
      fail the gate, content-current or not (unit + CLI validated).
