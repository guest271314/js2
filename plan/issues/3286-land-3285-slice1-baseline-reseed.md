---
id: 3286
title: "Land #3285 slice-1 (PR #3104) — oracle-version bump alone doesn't clear the #3086 auto-rebase gate for wasm-changing verdict flips"
status: ready
sprint: current
created: 2026-07-15
priority: high
feasibility: medium
model: opus
horizon: m
reasoning_effort: high
task_type: ci-infra
area: test-infrastructure
goal: test-infrastructure
related: [3285]
---

# #3286 — land #3285 slice-1 despite the CI-flagged "regression"

## Context

PR #3104 implements #3285 slice 1 (`transformAssertThrows` now threads the
expected error type through — `assert.throws(TypeError, fn)` compiles to a
real `e instanceof ErrorCtor` / name-fallback check instead of "did anything
throw"). The fix is validated correct: matcher sound across in-module/host/
subclass/`Test262Error` cases, 0 false-negatives in scoped batches. The
~2664-2668 test flips are legitimate false-positive corrections (previously-
inflated passes becoming honest fails) — exactly what #3285's own acceptance
criteria anticipated ("a drop is expected and correct... report the delta
rather than treating it as a regression").

The PR is currently `hold`-parked by `auto-park-bot` and **cannot land as-is**
— not because the fix is wrong, but because the CI landing mechanism has no
path for this specific shape of intentional reclassification.

## The blocking mechanism (verified empirically by two independent agents)

The `assert_throws`/`assert_throwsAsync` synthetic shims live in
`buildPreamble()` (`tests/test262-runner.ts`), which is compiled **into**
each test's wasm module. Tightening the shim's verdict logic therefore also
changes every affected test's `wasm_sha` — so all ~2664 flips register as
**wasm-CHANGE** regressions, not same-wasm oracle-skew.

`ORACLE_VERSION` was bumped 3→4 on the branch (necessary per
[[reference_verdict_logic_change_must_bump_oracle_version.md]]) — but this
alone is **not sufficient**. `scripts/diff-test262.ts`'s forward-bump
"rebase mode" only excuses flips carrying a `vacuous`/`vacuousReclassification`
marker (this is what let #3086 v2 land 1438 flips on a bare bump). #3285's
flips are plain `assertion_fail`/`type_error`, not vacuity-marked, so they
hit three independent gates:

- `regressionsWasmChange > ORACLE_REBASE_DRIFT_TOLERANCE` (25,
  `diff-test262.ts:1040`) — empirically confirmed: a 100-flip probe at
  oracle 3→4 produced `GATE FAIL: re-baseline residual 100 non-excused
  wasm-change regressions exceeds drift tolerance 25 (#3086)`, exit 1. The
  real flip count (2664-2668) is far larger.
- Per-bucket concentration check (>50 in a single bucket — class/dstr 168,
  Temporal prototypes 63-115, object/dstr 84, async-generator/dstr 56).
- The #1668 catastrophic guard (threshold 200), which **also runs on every
  push to `main`** and gates the `promote-baseline` job independently of the
  PR-level `merge_group` check — so admin-merging past the PR-level gate
  does not help either (see PR #3104 comment thread for the full writeup;
  admin-merge would strand the baseline and wedge the queue for every
  subsequent test262-touching PR, which is strictly worse than the current
  single held PR).

## Landing-path options (as escalated on the PR, unresolved by design this window)

- **(A) Maintainer `force_baseline_refresh` workflow_dispatch at oracle v4** —
  re-seeds the committed baseline directly rather than going through the
  normal diff-and-promote path. Cleanest if this workflow input exists and
  is safe to invoke mid-queue; needs verifying it doesn't require the same
  catastrophic-guard clearance internally.
- **(B) Temporarily raise `ORACLE_REBASE_DRIFT_TOLERANCE`, the #1668
  catastrophic-guard threshold, and the per-bucket-50 limit** high enough to
  let the 2668 flips through `merge_group` and `promote-baseline`, land, let
  `promote-baseline` re-seed host+standalone baselines at v4, then **revert
  the levers in a follow-up PR**. This is the "-439 landing" dance — shared-
  system risk (weakens the regression guard for every other in-flight PR
  during the window) and needs to be driven end-to-end by whoever owns it,
  including the revert step.
- **(C) Add an excusing marker** (mirroring #3086's `vacuous` tag) for this
  class of "assertion tightened, wrong-error-type flips from correct to
  incorrect" reclassification, so future verdict-logic changes of this shape
  don't need the lever dance at all. Proper fix, bigger scope than slice 1 —
  likely the right long-term answer given #3285 has two more slices (fixes
  #2 and #3) coming that will hit the exact same wall.

No option was executed this window — deferred solely due to insufficient
remaining budget to safely drive a multi-step, queue-wide-risk operation
end-to-end, not due to any doubt about the fix's correctness.

## Related follow-up (not in scope here, don't fold in)

The dedicated #3003 gate (`scripts/check-verdict-oracle-bump.mjs`) that's
supposed to flag any verdict-logic change missing an oracle bump did **not**
fire for PR #3104 — its `VERDICT_SIGNAL_RE` matches `status:`-literal
assignments but not runtime type-check logic inside a shim body (where
#3104's actual verdict change lives). Worth its own issue; flagged here so
it isn't lost, but fixing the gate doesn't unblock this landing.

## Acceptance criteria

- PR #3104 merges to `main` via one of the options above (or a variant),
  with `promote-baseline` succeeding and the committed baseline
  (`benchmarks/results/test262-current.json` +
  `loopdive/js2wasm-baselines` jsonl) correctly reflecting oracle v4.
- Any temporarily-raised guard/tolerance is reverted in a follow-up commit
  once the re-seed is confirmed — the queue must not be left with a
  permanently weakened catastrophic guard.
- No subsequent PR gets spuriously auto-parked against stale-baseline drift
  from this landing (spot-check the next few merge_group runs after landing).
- #3285 slices 2 and 3 (`stripUndefinedAssert`, full `strip*` inventory) are
  reassessed against whichever landing mechanism worked here, since they are
  the same shape of change and will hit the same wall.
