---
name: reference_single_pr_merge_group_refail_is_real_not_drift
description: "A single PR's merge_group test262 regression that RE-FAILS after a re-enqueue is a real bug, not baseline drift — diagnose, don't dismiss"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 12c43077-c2b6-4d65-be90-38a24eecc6a6
---

When ONE PR fails the merge_group `check for test262 regressions` gate, gets
parked, and **re-fails the same gate after a re-enqueue**, it is a **real
wasm_compile/codegen bug**, NOT baseline drift. Drift = *identical* regression
clusters across **unrelated** PRs (see [[feedback_baseline_drift_cross_check]]);
a single PR re-failing twice is the opposite signal. Dismissing it as "drift"
(as #2078/#2679's prior author did) re-admits the regressor and wedges it twice.

Concrete instance (#2078, fixed 2026-06-26): the number-hint `coerceType`
valueOf-threading **cached `ctx.currentThisGlobalIdx`** (the `__current_this`
global index) and reused the stale value for the RESTORE `global.set` AFTER
`buildDispatch(0)`. `buildDispatch` flushes a **late string-constant import**
mid-stream, which shifts the global index space; the shift pass bumps the
emitted save/install in lockstep but the **captured local went stale** → restore
targeted the post-shift (now f64) global → `global.set expected f64, found
externref` → invalid Wasm. It surfaces ONLY in the harness-wrapped shape, so it's
**merge_group-only** (PR-level CI is green). Fix: **read index-shift-sensitive
global/func indices FRESH at each emit site**, never cache across a
`buildDispatch`/late-import flush. Same family as the late-import index-shift
notes ([[reference_no_rebuild_helper_body_at_finalize]],
[[project_type_index_shift_and_deadelim]]).

Verify a real fix by **byte-identity**: regressed rows flip INVALID→valid, every
already-valid row stays byte-identical (improvements preserved, 0 new
regressions). Add a guard test that fails with the exact validation error on the
pre-fix code.
