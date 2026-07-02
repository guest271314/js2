---
id: 3004
title: "CI wedge fix: excuse #2940 vacuity reclassifications in the standalone (#1897) regression gate"
status: done
sprint: current
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
updated: 2026-07-02
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

Add an opt-in excusal to `scripts/diff-test262.ts`: exclude `pass→fail`
transitions whose NEW row is a #2940 vacuity reclassification (`vacuous === true`,
or `error` starting with `vacuous:`) from the gated regression count — mirroring
the existing #2879 §4 `--exclude-leaky-baseline-regressions` excusal.

- New flag: `--exclude-vacuous-reclassification`.
- Helpers: `isVacuousResult(entry)` and `isVacuousReclassification(base, cur)`.
- Excused flips are dropped from `regressionsWasmChange` (the `Regressions with
  wasm-hash change: N` line the #1897 guard greps) **and** therefore from the
  ratio/per-bucket gates (they read the same `noiseFiltered` set).
- The excused count is logged loudly and grep-ably:
  `=== Excused vacuous reclassifications (#2940 TEMPORARY … see #3001): N ===`.
- Wired into the workflow at the **Standalone regression guard (#1897)**
  invocation (the RED gate) and, defense-in-depth, the **Catastrophic
  regression guard (#1668)** invocation (host lane — inert today since the host
  baseline is already new-policy).

## Why TEMPORARY (removal follow-up #3001)

Once the next push-to-main run passes with this excusal, `promote-baseline`
banks ~1496 vacuous standalone rows → the standalone baseline becomes
new-policy. From then on the excusal excuses **zero** flips (the d822f85a
cluster can't recur), making it inert — and then a **mask**: a real codegen
break flipping a true-pass → "callback never executed" would be silently
forgiven. So it MUST be removed (or converted to a `vacuous-count-may-not-grow`
ratchet) immediately after the standalone baseline promotes. Tracked in **#3001**.

The permanent prevention (bump `oracle_version` on any vacuity/verdict policy
change so the gate refuses cross-policy diffs instead of misreading them as
regressions) is dev-3003's work (#3003).

## Test Results

`tests/issue-3004.test.ts` pins: a synthetic pass→vacuous-fail is excused under
the flag (REG 0, gate passes) and counted without it (REG 1, gate fails); a real
non-vacuous pass→fail still counts at full strength even with the flag; a genuine
net-negative alongside a vacuity flip still fails; and the workflow wires the flag
into the #1897 guard.
