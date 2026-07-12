---
id: 3202
title: "TypedArray.prototype.set (BigInt) — 4 tests emit uncatchable oob traps instead of catchable errors (regressed main oob 58->62)"
status: ready
created: 2026-07-12
priority: medium
feasibility: medium
task_type: bug
area: codegen
es_edition: multi
language_feature: typed-array
goal: crash-free
sprint: current
horizon: m
related: [3189, 3183, 3162, 3173]
origin: "Surfaced by the #3189 uncatchable-trap ratchet: main HEAD (commit 9626103a) grew the oob trap category 58->62 (+4). The baseline was force-refreshed (workflow_dispatch, 2026-07-12) to reconcile the ratchet 58->62 and unwedge the merge queue; this issue tracks the PROPER fix so the traps are removed rather than baked into the baseline."
---

# #3202 — TypedArray.prototype.set BigInt args emit uncatchable oob traps

## Problem

The #3189 uncatchable-trap ratchet caught the `oob` trap category growing
**58 -> 62 (+4)** on main HEAD (`9626103a`). Four `TypedArray.prototype.set`
BigInt tests newly emit an **uncatchable Wasm `oob` trap** where they should
either pass or throw a **catchable** JS error (RangeError/TypeError). An
uncatchable trap escapes `try`/`catch` and aborts the whole test file (#3179),
so each one poisons every test that shares the pattern — exactly the robustness
the crash-free goal + the #3189 ratchet exist to protect.

### The 4 newly-trapping tests
- `test/built-ins/TypedArray/prototype/set/BigInt/array-arg-offset-tointeger.js`
- `test/built-ins/TypedArray/prototype/set/BigInt/array-arg-primitive-toobject.js`
- `test/built-ins/TypedArray/prototype/set/BigInt/typedarray-arg-offset-tointeger.js`
- `test/built-ins/TypedArray/prototype/set/BigInt/typedarray-arg-set-values-diff-buffer-same-type.js`

These exercise `%TypedArray%.prototype.set(source, offset)` where `offset`
undergoes `ToInteger` coercion and the source is an array / typedarray, on a
BigInt-element typed array.

## Root cause (to confirm)

The +4 landed in the window between #2949 (the trap ratchet itself, merged
17:46Z) and `9626103a`. The array/vec bounds-handling changes in that window
(#3162 two-arm `find`; #3183 `__extern_has_idx` generalised to `$__vec_base`)
are the prime suspects for altering the `set` bounds/offset path so an
out-of-range offset now `array.set`-traps instead of taking a guarded catchable
path. Confirm by bisecting the 4 tests across #3162 / #3183, then trace the
`TypedArray.prototype.set` offset-bounds codegen (`src/codegen/` typed-array set
lowering).

## Fix

Make the offset/length bounds check on `TypedArray.prototype.set` emit a
**catchable** RangeError (per spec: `set` throws RangeError when
`srcLength + targetOffset > targetLength`, and offset < 0 -> RangeError) rather
than falling through to an unguarded `array.set` that traps `oob`. Mirror the
guarded-bounds pattern used elsewhere in the standalone array path.

## Acceptance criteria

1. The 4 tests above no longer emit an `oob` trap (they pass, or throw a
   catchable error that `assert.throws` observes).
2. The #3189 `oob` ratchet count returns to **58** (or lower) on main — i.e. the
   +4 introduced in this window is genuinely removed, not just baselined.
3. Zero net test262 regressions; zero new traps in any category.

## Context

- Baseline was reconciled 58->62 via `workflow_dispatch` force_baseline_refresh
  on 2026-07-12 to unwedge the merge queue (every PR's `merge_group` was
  parking on this ratchet). That refresh made the +4 the accepted baseline;
  THIS issue removes them so the ratchet protection is restored at the lower
  count.
- Gate/ratchet: `scripts/diff-test262.ts` `evaluateTrapCategoryGrowth`
  (`TRAP_ERROR_CATEGORIES`), #3189.
