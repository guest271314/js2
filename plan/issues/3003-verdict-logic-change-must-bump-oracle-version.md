---
id: 3003
title: "Postmortem + prevention: a test262 verdict-logic change must bump oracle_version (two queue wedges)"
status: done
assignee: ttraenkler/dev-3003
created: 2026-07-01
completed: 2026-07-02
priority: high
feasibility: hard
task_type: infra
area: ci
sprint: 69
horizon: m
related: [2096, 2920, 2940, 1668, 1897, 2528, 2547]
---

# Postmortem: two intentional-reclassification queue wedges (verdict logic vs. an old-policy baseline)

## Summary

In the last 24h the merge queue wedged **twice** with the **same root cause**:
a PR changed test262 **verdict logic** — *how a per-test result is scored* —
without bumping the `oracle_version` (#2096). The new-policy results then diffed
against the **old-policy** committed baseline as a mass `pass→fail` cluster,
which tripped the required regression guards and blocked the very
`promote-baseline` run that would have re-seeded the baseline at the new policy.

This issue is the **postmortem** plus a **prevention CI check** (in the required
`quality` lane) that fails a verdict-logic change which neither bumps
`oracle_version` nor carries a conscious in-diff override.

## The two wedges

### Wedge 1 — the −439 strict-negative-verdict change (issue #2920)

The negative-test verdict logic was tightened (parse/early/resolution negatives
must reject for the *right* reason), reclassifying ~439 rows. This one was
**handled correctly but expensively** with a coordinated **temporary-lever
dance**:

1. raise the #1668 catastrophic guard threshold (200 → 500),
2. add an `INTENTIONAL_REGRESSION_BUDGET`,
3. lower the standalone floor,
4. land the PR, let `promote-baseline` re-seed the new-policy baseline,
5. revert the levers.

It worked, but it is fragile: it requires touching multiple guards in lockstep,
and missing any one of them leaves the queue red (see "The 3-guard surface").

### Wedge 2 — PR #2463's vacuity scorer (merged `0670ea4`, issue #2940)

PR #2463 added a **vacuity honesty-reclassifier**: a harness-wrapper test whose
callback never executed (so *no assertion ran*) is no longer scored `pass`. It
reclassified ~1,438 host + standalone passes to `fail` with the reason
`vacuous: harness-wrapper callback never executed (#2940) — no assertion ran`
(in `scripts/test262-worker.mjs` ~line 1370, plumbed through
`tests/test262-shared.ts`).

It did **NOT** do the lever dance. The failure chain:

1. The push-to-main run's **Catastrophic regression guard (#1668)** saw the huge
   new-policy-vs-old-policy delta and **failed**.
2. Because that guard lives inside the required "merge shard reports" check, the
   `promote-baseline` job **never ran** on that run.
3. So the committed baseline stayed **old-policy**.
4. Every subsequent `merge_group` then diffed **new-policy-vs-old-policy** →
   the *identical* cluster signature `d822f85a0aabd092` → **auto-park** (#2547)
   → the queue **wedged** against a baseline that could only be fixed by the
   promote the guard was blocking.

**How it self-resolved:** the #2528 promote-baseline-race fix plus a scheduled
baseline refresh eventually promoted the new-policy baseline — confirmed at
baselines-repo commit `e3d8167`, built from main `697ce0e`, a descendant of
#2463. Once the baseline was new-policy, the cluster vanished and the queue
cleared. This was luck-of-timing, not a designed recovery.

## Root cause

Both wedges are the same defect: **a verdict-logic change was landed as if it
were a code change.** The #2096 oracle-version machinery exists precisely to
distinguish the two:

- A **code change** should be measured against the baseline — a `pass→fail`
  delta is a real regression and *should* fail the guards.
- A **verdict-logic (oracle) change** re-scores *the same compiler output*.
  Its `pass→fail` delta is **oracle skew, not a regression**, and must be
  handled as a **re-baseline**, not measured as a regression.

`oracle_version` is the switch. `tests/test262-oracle-version.ts` stamps every
result row and every baseline/merged report with `ORACLE_VERSION`, and
`scripts/diff-test262.ts` **refuses** to diff a baseline against a candidate
whose `oracle_version` differs (unless `ORACLE_REBASE=1`). So had either PR
**bumped `ORACLE_VERSION`**, the guards would have *refused the cross-oracle
diff* (or required `ORACLE_REBASE=1` for the deliberate re-seed) instead of the
catastrophic guard blocking the promote that fixes the baseline.

Neither PR bumped it. #2463 in particular changed the scoring in
`test262-worker.mjs`/`test262-shared.ts` while leaving `ORACLE_VERSION = 1`.

## The 3-guard surface (a lever/excusal must reach ALL THREE)

A verdict-logic temporary-lever or excusal that reaches only *some* of the
baseline-diffing guards leaves the queue red. There are **THREE** required
checks that diff against the baseline on `merge_group` — an earlier remediation
plan wired only two of them:

1. **Catastrophic regression guard (#1668)** — `test262-sharded.yml` (~line 674),
   inside the required **"merge shard reports"** job. `CATASTROPHIC_REGRESSION_THRESHOLD`
   (200; raised to 500 during the −439 dance). Counts host `pass→fail` with a
   changed wasm-hash vs the host baseline.
2. **Standalone regression guard (#1897)** — `test262-sharded.yml` (~line 748),
   also inside "merge shard reports". A much **tighter** floor
   (`STANDALONE_REGRESSION_TOLERANCE`) for the standalone lane.
3. **`check for test262 regressions`** — the `regression-gate` job in
   `test262-sharded.yml` (~line 945, name at ~line 956). The fine-grained
   regression gate; **also** blocks the merge queue and **also** diffs against
   the baseline. This is the third guard the earlier plan missed.

> If you ever *must* run the lever dance again, the levers/excusals must reach
> **all three** or the queue stays red. This is the core argument for preferring
> the oracle bump: one bump makes `diff-test262.ts` refuse the cross-oracle diff
> *uniformly*, so all three guards are satisfied at once.

## Recommendation

**Intentional honesty-reclassifications should bump `oracle_version`, not run
the fragile lever dance.** The two landing paths for a verdict-logic change:

- **(a) Bump `ORACLE_VERSION`** in `tests/test262-oracle-version.ts` (increment
  the integer + append to `ORACLE_VERSION_HISTORY`) and land the PR with
  `ORACLE_REBASE=1` so the diff gate accepts the cross-version re-baseline and
  `promote-baseline` re-seeds at the new version. **Clean, single-lever, reaches
  all three guards at once.** ← preferred.
- **(b) The coordinated temporary-lever dance** (raise guard + regression budget
  + lower standalone floor, land, promote, revert). Fragile; must reach all
  three guards; use only when a bump is somehow inappropriate.

## Prevention (this PR)

A `quality`-lane gate — `scripts/check-verdict-oracle-bump.mjs`
(`pnpm run check:verdict-oracle`) — flags any PR that changes verdict logic
without bumping the oracle:

- **Verdict-logic file surface** (grep-derived authoritative set):
  - PURE (any substantive change is a signal): `scripts/negative-verdict.mjs`.
  - MIXED (only a **verdict-signal** line counts): `scripts/test262-worker.mjs`,
    `tests/test262-shared.ts`, `tests/test262-vitest.test.ts`,
    `tests/test262-runner.ts`.
  - Oracle file (the bump target): `tests/test262-oracle-version.ts`.
- **Verdict-signal detection** (line-level, low false-positive): a changed line
  that SETS a verdict `status` literal, touches the `vacuous` marker, or touches
  the negative-test / `classifyError` machinery. `status ===` / `.status` READs
  are deliberately **not** matched, so report aggregation or a guard comparing a
  status does not trip the gate. A comment fix or worker-recycle tweak to the
  mixed files passes clean.
- **Bump detection:** the check parses `ORACLE_VERSION` at the diff base and at
  HEAD and requires `head > base`.
- **Verdict:**
  - no verdict-logic file changed, or no verdict-signal line → **pass**;
  - verdict-signal change **with** an oracle bump → **pass** (correct: the
    honesty reclassification bumped the oracle);
  - verdict-signal change **without** a bump but **with** an in-diff
    `// oracle-version-exempt: <reason>` comment → **warn** (trusts the author's
    assertion that zero existing rows flip, e.g. the #2912 dead-ternary case);
  - verdict-signal change **without** a bump **and without** the override →
    **HARD FAIL**, pointing at the bump procedure.
- **Why the override is in-diff, not the PR body:** the PR body is absent in
  `merge_group`, so a body-based override (`contains(github.event.pull_request.body, …)`)
  would pass on `pull_request` then FAIL in the queue — re-creating the very
  wedge this gate prevents. The override token lives in the DIFF, so it survives
  the `merge_group` re-run.

Both wedge shapes (the #2463 vacuity scorer and the −439 negative-verdict change)
are exercised as HARD-FAIL cases in `tests/issue-3003.test.ts`; the #2912
dead-ternary (0-flip) case is exercised as the WARN/override case.

## Acceptance criteria

- [x] Postmortem documents both wedges, the shared root cause, the two
      resolution paths, and the 3-guard surface.
- [x] `quality`-lane check fails a verdict-logic change with no oracle bump and
      no override; passes a no-op/unrelated PR and a bumped/overridden change.
- [x] Unit test (`tests/issue-3003.test.ts`) covers both wedge shapes + the
      override path.
- [x] Check verified not to false-positive on unrelated PRs (no-op diff) and to
      fail on a scorer-diff-without-bump.

## Test Results

- `pnpm exec vitest run tests/issue-3003.test.ts` → 10/10 pass.
- CLI smoke: `node scripts/check-verdict-oracle-bump.mjs --base origin/main` on
  this PR (touches no verdict-logic files) exits 0; a synthetic
  scorer-diff-without-bump exits 1 (see `## Verification`).
