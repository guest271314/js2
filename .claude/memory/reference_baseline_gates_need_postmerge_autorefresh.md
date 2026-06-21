---
name: reference_baseline_gates_need_postmerge_autorefresh
description: Every prescriptive baseline gate must self-refresh post-merge in promote-baseline or it wedges all PRs via drift
metadata: 
  node_type: memory
  type: reference
  originSessionId: bfd08410-1338-48a9-8466-6d713e23be7d
---

Any CI gate that checks a committed baseline file (conformance #1636, hard-errors #1853, coercion-sites #2108) MUST be `--update`'d in the `promote-baseline` job of `.github/workflows/test262-sharded.yml` (post-merge, every push to main) and staged in its `stage_files()`. Otherwise the baseline only ever moves by hand, and main drifts internally inconsistent whenever a sanctioned addition lands via admin-bypass merge, concurrent-PR baseline merge conflict, or a lost manual bump — at which point EVERY open PR fails the gate until someone hand-bumps it (the 2026-06-18 #1670 coercion wedge that stalled the drain).

The coercion gate (`scripts/check-coercion-sites.mjs`) is a pure source-grep over `src/codegen/**` — no test262 dependency — so the merged HEAD's source IS the new ground truth; growth is still caught at PR time, the post-merge `--update` only banks sanctioned additions. Fix shipped in #1687 (mirrors the #1853 hard-error pattern; also mirrored in the hourly `baseline-summary-sync.yml` fallback).

Litmus test when a NEW prescriptive gate is added: "what refreshes its baseline on main after a merge?" If the answer is "a human," it will wedge. See [[feedback_baseline_drift_cross_check]].
