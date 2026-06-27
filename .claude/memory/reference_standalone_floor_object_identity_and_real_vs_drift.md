---
name: reference_standalone_floor_object_identity_and_real_vs_drift
description: "merge_group standalone-floor park diagnosis — a shared bucket signature across UNRELATED PRs can be a REAL earlier-merge regression (NOT drift); verify the regressed test PATHS before refreshing the baseline. Plus: standalone native equality helpers must preserve object identity via ref.eq."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8c1a4e31-7549-4d26-8712-eeb6350092ec
---

**Sprint 67 (#2719/#2734/#2163) — a queue wedge that looked like drift but was a real regression.** Three unrelated PRs (#2717 standalone flat/flatMap, #2716 linear try/finally, #1830 property-access) all auto-parked on the **standalone regression guard** ("merge shard reports") with the **same bucket signature** `fb9900322f32d212` (20 pass→fail, all assertion_fail). The guard's own footer + [[feedback_baseline_drift_cross_check]] say "same signature across PRs ⇒ likely drift" — and I nearly recommended a **baseline refresh**, which would have BLESSED 20 genuinely-broken tests.

**It was REAL, not drift.** dev2 verified by pulling the regressed test PATHS: all 20 were `Array.indexOf/lastIndexOf/includes` with **object elements** (`[0,o].indexOf(o)` → -1). Reproduced on current main. Caused by **already-merged #2719** (baseline sha predated it by 4 min). #2716 being **linear-only can't touch WasmGC-standalone** → the shared signature across an impossible-cause PR was the tell it wasn't PR-caused-per-PR but a common earlier-merge regression the floor flags on every subsequent PR.

**Rules learned:**
1. A shared standalone-floor signature across unrelated PRs is NOT automatically benign drift. If the common cause is an EARLIER merged PR whose baseline-sha predates it, the regression is REAL — a baseline refresh blesses broken tests. **Verify the regressed test PATHS (what kind of test) and which merged PR could cause them BEFORE refreshing.** A linear-only PR cannot regress WasmGC-standalone — that asymmetry disambiguates.
2. **Fix forward** (a `ref.eq` object-identity fast-path in the native helper), never refresh-to-bless. Once the fix merges it restores the tests (+improvements pass the floor) and refreshes the baseline → all the collateral-parked PRs clear with no change.

**Root-cause class — standalone native equality must preserve object identity.** `__any_from_extern` (src/codegen/any-helpers.ts) has NO Object tag → folds an object externref into the **tag-5 (string) fallback**, so `__any_strict_eq`/`__extern_strict_eq`/`__extern_same_value_zero` string-compare two objects and never match by identity. The old host `__host_eq` path was correct; swapping it for a native helper silently drops identity. **Fix: `ref.eq` reference-identity fast-path in `ensureExternStrictEqHelper` (internalize both externrefs + ref.eq → 1, else fall through to primitive compare).** When converting any host equality to a standalone-native arm, object identity is the easy thing to lose — add an object-identity test. See [[project_standalone_floor_only_on_merge_group]], [[reference_single_pr_merge_group_refail_is_real_not_drift]].
