---
name: reference-verdict-logic-change-must-bump-oracle-version
description: A test262 scorer/verdict-logic change must bump
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

Root cause of BOTH intentional-reclassification queue wedges in 2026-07 (the −439 strict-negative-verdict and the #2463 vacuity-scorer). When a PR changes VERDICT LOGIC (how a test262 result is scored: test262-worker.mjs / test262-shared.ts / a scorer like the vacuity reclassifier), the new-policy results diff against the OLD-policy baseline as a mass pass→fail cluster. If the change does NOT bump the #2096 `oracle_version`:

- the push-to-main run's Catastrophic regression guard (#1668) sees the huge delta and FAILS → `promote-baseline` never runs → baselines stay old-policy → every merge_group since diffs new-vs-old → identical cluster signature → auto-park → the whole queue wedges against a baseline that can only be fixed by the promote the guard is blocking.

**Prevention (the durable fix, reserved as #3003):** a CI check that flags any change to scorer/verdict-logic files that does NOT also bump `oracle_version`. When the oracle IS bumped, the guards correctly refuse the cross-oracle diff (or require `ORACLE_REBASE=1`) instead of catastrophic-blocking the promote.

**How to apply:** landing an intentional honesty reclassification (verdict-logic change) requires EITHER (a) bump `oracle_version` so the guards treat it as a re-baseline not a regression, OR (b) the coordinated temporary-lever dance (raise the guard + regression-budget, land, promote, revert — see the −439 landing). (a) is cleaner. Also note there are THREE required checks that diff vs baseline on merge_group — the two guards PLUS `check for test262 regressions` (test262-sharded.yml regression-gate job) — a lever/excusal must reach all three. Related: [[feedback_baseline_gates_need_postmerge_autorefresh]], [[reference_baseline_gates_need_postmerge_autorefresh]].
