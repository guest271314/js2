---
id: 3004
title: "CI wedge fix: excuse #2940 vacuity reclassifications in the standalone (#1897) regression gate"
status: done
sprint: 69
priority: high
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: ci/test-infra
language_feature: test262-gate
goal: merge-queue-health
assignee: ttraenkler/dev-unwedge
related: [2940, 2463, 3001, 1897, 1668, 2879]
created: 2026-07-02
updated: 2026-07-03
completed: 2026-07-02
origin: "2026-07-02 merge-queue wedge. #2463's vacuity scorer (merged 0670ea4) rescored ~1438 vacuous passes → fail without bumping oracle_version; HOST baseline re-promoted new-policy but STANDALONE baseline left stale old-policy (sha cab96808), so every code PR's merge_group standalone diff trips #1897 on the d822f85a −1438 cluster. Diagnosis: shepherd-o (run 28618870469)."
---

## Problem

The merge queue is WEDGED. #2463's vacuity scorer (merged `0670ea4`) reclassified
~1438 vacuous "passes" (harness-wrapper callback never executed → no assertion
ran) to `fail`, with the canonical error `vacuous: harness-wrapper callback never
executed (#2940) — no assertion ran` and a `vacuous: true` marker on the JSONL
row. Crucially it did **not** bump the #2096 `oracle_version`, so the diff gate
treats old-policy `pass` rows vs new-policy `vacuous`-`fail` rows as genuine
regressions.

The HOST baseline (`test262-current.jsonl`) was re-promoted to new-policy (1496
vacuous rows). The **STANDALONE** baseline (`test262-standalone-current.jsonl`,
sha `cab96808`) was **not** — it still records those rows `pass`. So every code
PR's `merge_group` runs new-policy standalone code and diffs it against the
0-vacuous standalone baseline → the same cluster signature `d822f85a0aabd092`,
Net −1438 (buckets TypedArray/set 84, filter 70, map 66). The failing required
check is **"merge shard reports"** via the **Standalone regression guard
(#1897)**; the host **"check for test262 regressions"** passes (host baseline is
new-policy). Same signature across unrelated PRs ⇒ baseline drift, not a real
regression.

## Fix

Exclude `pass→fail` transitions whose NEW row is a #2940 vacuity
reclassification (`vacuous === true`, or `error` starting with `vacuous:`) from
the gated regression count in `scripts/diff-test262.ts` — **UNCONDITIONALLY
(default-on)**, mirroring the #2167 `isStaleAsyncArgsFlake` exclusion (NOT the
flag-gated #2879 §4 leaky excusal).

- Helpers: `isVacuousResult(entry)` and `isVacuousReclassification(base, cur)`.
- Excused flips are dropped from `regressionsWasmChange` (the `Regressions with
wasm-hash change: N` line the #1897 guard greps) **and** therefore from the
  ratio/per-bucket gates (they read the same `noiseFiltered` set).
- The excused count is always logged loudly and grep-ably:
  `=== Excused vacuous reclassifications (#2940 TEMPORARY default-on … see #3001): N ===`.
- **No workflow change.** `.github/workflows/test262-sharded.yml` is unchanged.

### Why default-on and NOT a YAML flag (the self-land invariant)

A `merge_group` check runs the workflow YAML from the **base branch (main)**,
but checks out the **merged-tree scripts**. If the excusal were gated behind a
new `--exclude-vacuous-reclassification` flag added only in this PR's YAML, that
flag would **not** be passed in this PR's own `merge_group` (main's flag-free
YAML runs) → the merged-tree script would not excuse the cluster → the #1897
guard would still fail → **this PR would park itself and could not land to fix
the wedge (deadlock).** This is exactly the trap that cost the −439 landing
(#2424) multiple parked attempts. The leaky excusal only works in `merge_group`
because its flag is _already on main's YAML_; a brand-new flag is not. Making the
exclusion default-on in the merged-tree script fires it in every `merge_group`
regardless of which YAML runs, so this fix self-excuses and lands.

## Why TEMPORARY (removal follow-up #3001)

Once the next push-to-main run passes with this excusal, `promote-baseline`
banks ~1496 vacuous standalone rows → the standalone baseline becomes
new-policy. From then on the default-on exclusion excuses **zero** flips (the
d822f85a cluster can't recur), making it inert — and then a **mask**: a real
codegen break flipping a true-pass → "callback never executed" would be silently
forgiven. So it MUST be removed (or converted to a `vacuous-count-may-not-grow`
ratchet) immediately after the standalone baseline promotes. Tracked in **#3001**.

The permanent prevention (bump `oracle_version` on any vacuity/verdict policy
change so the gate refuses cross-policy diffs instead of misreading them as
regressions) is dev-3003's work (#3003).

## Test Results

`tests/issue-3004.test.ts` (13 tests) pins: a synthetic pass→vacuous-fail is
excused **by default with no flag** (REG 0, gate passes) — the `merge_group`
self-land property; a real non-vacuous pass→fail still counts at full strength
(REG 1, gate fails); a genuine net-negative alongside a vacuity flip still fails;
the excused-count line is always emitted; and the workflow does **not** pass a
vacuity flag (guards against re-introducing the deadlock-prone flag design).
Also wired into the `quality` CI job (`ci.yml`) so the gate logic is executed in
CI. Local: typecheck ✓, biome lint ✓, prettier ✓, issue-ids:against-main ✓.
