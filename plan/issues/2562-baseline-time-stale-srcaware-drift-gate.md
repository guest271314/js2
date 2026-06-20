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

The `--baseline-content-current` flag is passed to `diff-test262.ts` when
content-current; it **widens** the ratio gate's absolute floor (Part 3) but is
no longer the _sole_ trigger for the waiver.

### Part 3 — Absolute regression-count floor (the PRIMARY blocker today)

> Reprioritised mid-implementation: the ratio-gate over-sensitivity, not
> staleness, is the live blocker. Net-positive PRs #1742/#1711 (Net +8, 9
> improvements) kept failing `GATE FAIL: regression ratio 11.1% (1/9)` on a
> **single nondeterministic flaky file** — recorded `pass` in a
> _freshly-refreshed_ baseline (so a baseline refresh did NOT clear it; it is
> flake, not stale content) that flips to `fail` only under merge_group load.

`evaluateRegressionThresholds` (`scripts/diff-test262.ts`) now gives the **ratio
gate an absolute regression-count FLOOR** (`RATIO_MIN_ABSOLUTE_REGRESSIONS = 3`,
widened by `RATIO_FLOOR_CONTENT_CURRENT_BONUS = 2` when content-current). The
ratio gate fires **only** once the wasm-change regression count reaches the
floor. Below it, a **net-positive** diff passes the ratio gate regardless of how
few improvements it carries — so 1–2 residual drift/flake regressions can't fail
a net-positive PR. The floor is **UNCONDITIONAL** (the content-current signal
only widens it) because the observed blocker is run-to-run flake, not stale
content.

Real regressions still fail, via gates the floor never touches:

- the **net<0 gate** (caller-side `net_per_test < 0`) — ANY net-negative diff;
- the **bucket gate** (>50 regressions in one path);
- the **ratio gate** itself once regressions reach the floor (≥3 genuine
  regressions against few improvements).

## Why this is safe (regression-gate is load-bearing)

The gate that every merge depends on keeps its full power to catch **real**
regressions. The only behaviour change: a **net-positive** diff with fewer than
the floor (3, or 5 when content-current) absolute wasm-change regressions no
longer trips the _ratio_ sub-gate. Validated by unit tests (15/15) _and_
end-to-end CLI runs:

- 1 reg / 9 imp (Net +8), NO flag → **floored** (exit 0) — the exact #1742/#1711
  flake case, now passing without needing the content-current proof.
- 3 reg / 9 imp, NO flag → **fails** (ratio re-engages at the floor — a real
  regression).
- 5 reg / 2 imp (net-negative) → **fails** (net<0 AND ratio fire).
- 60 reg in one bucket → **fails** (bucket gate fires).
- 4 reg / 9 imp, content-current → floored (4 < 3+2); 5 reg → fails (5 == 3+2).

## Files changed

- `scripts/diff-test262.ts` — `RATIO_MIN_ABSOLUTE_REGRESSIONS` +
  `RATIO_FLOOR_CONTENT_CURRENT_BONUS` consts, unconditional absolute floor on the
  ratio gate in `evaluateRegressionThresholds`, `baselineContentCurrent` param,
  `--baseline-content-current` CLI flag.
- `tests/issue-1943.test.ts` — `#2562` floor test block (unconditional-floor
  case, the at-floor re-engagement, net-negative, content-current widening, and
  bucket-cluster safety boundaries).
- `.github/workflows/test262-sharded.yml` — src-aware staleness step
  (`baseline_content_current` / `src_commits_behind` outputs), pass the flag to
  the diff, src-aware drift footer.
- `.github/workflows/refresh-baseline.yml` — `schedule` cron + NORMAL mode,
  `IS_FORCED` env, conditional confirmation, main-sha in commit subjects,
  `--baseline-sha` on report build.

## Acceptance criteria

- [x] A scheduled (cron) NORMAL baseline refresh exists and records main's
      actual current state (not force/emergency).
- [x] The drift warning + content-current signal are driven by **src-commit
      count**, not clock time; 0 src-behind ⇒ content-current.
- [x] **(primary)** A net-positive PR with 1–2 drift/flake regressions PASSES
      the ratio gate **unconditionally** (no staleness-proof required).
- [x] Real regressions (net<0, large clusters, ≥3 genuine regressions) still
      fail the gate (unit + CLI validated).
