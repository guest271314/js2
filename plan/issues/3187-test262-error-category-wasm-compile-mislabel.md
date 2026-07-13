---
id: 3187
title: "test262 runner: error_category classifier mis-bins ~80% of 'wasm_compile' — missing-builtin / missing-dependency need own buckets"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-forin-sound
created: 2026-07-12
priority: medium
feasibility: easy
task_type: chore
area: test-infra
goal: process
sprint: 71
horizon: s
related: [3024, 3003, 3086, 1595]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, §F4)"
---

# #3187 — error_category: split missing_builtin / missing_dependency out of wasm_compile

## Problem

The default-lane baseline carries **448** non-pass records with
`error_category: "wasm_compile"`, but only **~87** are genuine Wasm
validation/instantiation failures (`invalid Wasm binary (…Compiling
function…)`). Shape census (2026-07-12 baseline):

```
 56  safeBroadcast is not a function            ← Atomics harness helper missing
 44  safeBroadcastAsync is not a function       ← missing builtin
 87  invalid Wasm binary (…)                    ← GENUINE wasm_compile
 38  object is not a function                   ← callable mis-dispatch
 34  No dependency provided for extern class "BigInt"
 22  No dependency provided for extern class "FinalizationRegistry"
 22  undefined is not a function
 38  transfer/transferToImmutable/transferToFixedLength is not a function (#1595)
 10  then is not a function
  5  sumPrecise is not a function
```

Root cause — `tests/test262-runner.ts:4241`:

```ts
if (/Compiling function|No dependency provided|not a function/i.test(errorMsg)) return "wasm_compile";
```

`… is not a function` (a missing builtin/runtime feature) and
`No dependency provided for extern class "X"` (the compiler's own
dependency-injection diagnostic) are **not** invalid-Wasm.

## Why it matters

- #3024 ("invalid Wasm residual, ~131") is sized off a polluted bucket — the
  category inflates the genuine invalid-Wasm class ~3.4×.
- Every `/harvest-errors` sweep and `/analyze-regression` bucket report
  misroutes ~360 records; the merge-gate "single bucket >50" escalation rule
  keys off these categories, so a real invalid-Wasm regression can hide inside
  missing-builtin noise (and vice versa).

## Fix

In the categorizer around `tests/test262-runner.ts:4241` (doc block at
`:4207`), classify **in this order**:

1. `/invalid Wasm binary|Compiling function/` → `wasm_compile` (genuine).
2. `/No dependency provided for extern class/` → `missing_dependency` (new).
3. `/\bis not a function\b/` → `missing_builtin` (new). Keep it AFTER 1 so
   instantiate errors that quote source aren't stolen.
4. Leave `no test export` (`:4244`) where the team decides — it is also not
   Wasm-invalid; suggest `harness_shape`.

## Constraints (learned the hard way — #3003)

**A verdict/classification-logic change MUST bump `oracle_version`** (two merge
queue wedges resulted from skipping this). Bump it, and note in the PR that
bucket counts in `test262-current.jsonl` will shift labels without any
pass/fail flips (net_per_test 0 expected; regression-gate noise is
label-only). Check `tests/issue-1908.test.ts:52` / `tests/issue-1781.test.ts:48`
(they assert `wasm_compile` strings) and update fixtures.

## Acceptance criteria

1. Post-change baseline: `wasm_compile` ≈ 90 ± 15; new `missing_builtin` /
   `missing_dependency` buckets absorb the rest; zero pass/fail flips.
2. `oracle_version` bumped; affected fixture tests updated.
3. #3024's problem statement re-anchored to the honest count (one-line edit).

## Resolution (2026-07-12, dev-forin-sound)

`classifyError` (`tests/test262-runner.ts`) now classifies in this order:

1. `/invalid Wasm binary|Compiling function/` → `wasm_compile` (genuine, first).
2. `/No dependency provided/` → `missing_dependency` (new — captures BOTH
   `extern class "X"` and `imported function env::__X` forms; broader than the
   issue's `extern class`-only suggestion so the DI diagnostic is binned
   consistently).
3. `/\bis not a function\b/` → `missing_builtin` (new — kept AFTER rule 1 so an
   instantiate error that quotes source isn't stolen).
4. `/no test export/` → `harness_shape` (new — was `wasm_compile`; the module
   compiled fine, it just exposes no `test` export).

- `ORACLE_VERSION` bumped 2 → 3 (`tests/test262-oracle-version.ts`) with a
  history entry; the `check-verdict-oracle-bump` gate passes. **Label-only:
  zero pass/fail flips** — no verdict changes, only category names. The
  regression-gate bucket diff on the next promote is label-noise (ORACLE_REBASE).
- Fixtures: `tests/issue-1781.test.ts` updated (the `No dependency provided …`
  record moves `wasm_compile` → `missing_dependency`, signature + assertion).
  `tests/issue-1908.test.ts` unchanged — its error quotes `Compiling function`
  so it stays `wasm_compile` (rule 1). New unit test `tests/issue-3187.test.ts`
  pins all four buckets + the ordering guarantee + the oracle bump.
- #3024 problem statement re-anchored (one-line block) — its 131 is the genuine
  validator-error subset, not the ~448 raw `wasm_compile` error_category count.

### Acceptance criteria disposition
1. Post-change: genuine `wasm_compile` narrowed to `invalid Wasm binary`/
   `Compiling function` (~87–131); `missing_builtin` / `missing_dependency` /
   `harness_shape` absorb the rest; zero pass/fail flips. ✓ (verified via
   `classifyError` unit test; baseline bucket counts shift on next promote.)
2. `oracle_version` bumped; affected fixtures updated. ✓
3. #3024 re-anchored to the honest count. ✓

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F4.
