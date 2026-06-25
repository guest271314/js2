---
id: 2672
title: "Refresh stale equivalence baseline; #2660 S1 toPrimitive 'regression' already fixed-forward by #2664 (main-health)"
status: done
assignee: ttraenkler/sendev-toprim
completed: 2026-06-25
sprint: 66
feasibility: hard
reasoning_effort: max
depends_on: []
blocks: [2063]
---

## Problem

The `equivalence-gate` CI check was reported wedging all open PRs, attributed to:
1. A regression on main from #2660 S1 (`9bf333da`, "inert whole-program
   escape/dynamic-use gate for new F() instances") breaking 4
   `Symbol.toPrimitive` (#482) equivalence tests
   (`tests/equivalence/symbol-toPrimitive.test.ts`), and
2. A stale `scripts/equivalence-baseline.json` (predates #2660; ~50-test drift).

## Root cause (verify-first, current main)

Re-probed on CURRENT main (`7f3fcbf143c5` — past `9bf333da`; includes #2664,
#2663 S1, #2029 fixes that landed after #2660 S1).

### 1. The escape-gate "toPrimitive regression" was a MISATTRIBUTION — already fixed-forward

- **All 4 `symbol-toPrimitive.test.ts` tests PASS on current main** (verified
  per-process twice via vitest fork-worker). No live toPrimitive failure exists.
- **#2660 S1 (`9bf333da`) is provably INERT.** The entire commit is: a new
  pure-analysis file `src/codegen/fnctor-escape-gate.ts`, one optional field
  `fnctorEscapeGate?` on `CodegenContext`, and one call site
  `index.ts:1075` that *stores* the analysis result. `git grep` confirms
  `ctx.fnctorEscapeGate` is **read by NO lowering code** — it cannot change
  emitted Wasm for `new MyNum()` / `new Both()` or anything else. The commit's
  own claim (byte-identical Wasm, sha-verified) is structurally true.
- The dev-2083 bisection (tests fail at `9bf333da`, pass at parent `ce9da195`)
  was real at that anchor, but the *mechanism* was misattributed to the escape
  gate. Because the gate is inert, the codegen for the toPrimitive path could
  not have differed across `9bf333da`. The actual corrective change is **#2664**
  (`782213b43ba9` "defer member-set struct dispatch to a finalize-filled
  `__set_member_<name>`" + `d6c790f9bc11` "route member-set field coercion
  through the coercion engine"), which landed AFTER `9bf333da` and rewrote the
  exact `this.value = v` constructor field-write / member-set dispatch path that
  the `MyNum`/`Both` tests exercise. That fix-forward is already on main.

**Conclusion for the gate:** nothing to fix-forward in the escape gate. It is
genuinely inert; the toPrimitive path is correct on current main. Reverting or
editing #2660 S1 is unnecessary (and would touch the parallel session's
value-rep substrate for no gain). Step 2 of the brief is satisfied by main as-is.

### 2. The actual wedge driver = stale equivalence baseline

`scripts/equivalence-baseline.json` was last meaningfully refreshed at
`fd889f134675` (#2092), well before #2660. It listed 116 known-failures; the
full gate on current main finds **48 of them now PASS** (newly-fixed) — the
~50-test drift. A purely-stale *superset* baseline does not by itself fail the
gate (newly-fixed = ratchet suggestion, not error), but the drift makes the gate
unreliable repo-wide and masks real new regressions, so it must be refreshed
against a correct main.

## Fix

Refresh `scripts/equivalence-baseline.json` against current (correct) main via
`node scripts/equivalence-gate.mjs --update`. No compiler-source change: the
escape gate stays inert and the toPrimitive path is already correct.

## Test Results

- `tests/equivalence/symbol-toPrimitive.test.ts` — 4/4 PASS on current main
  (re-confirmed per-process, fork-worker).
- Full equivalence gate on current main: 0 new regressions; 48 baseline entries
  now pass (recorded as the refresh delta).
