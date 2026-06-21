---
id: 1887
title: "async-generator yield* emits invalid Wasm (array.set in __closure) — 325 default-lane CE"
status: done
sprint: 64
created: 2026-06-05
updated: 2026-06-21
completed: 2026-06-21
resolved_by: 2170, 2171
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: async-generators
---

## Resolution (2026-06-21, sd-4 reproduce-first) — symptom fixed; residual → #2570

The filed symptom (325 invalid-Wasm `array.set` CEs in async `yield*` closures)
is **already fixed on main** — resolved by intervening #2170/#2171
(native-generator + result-struct work). Re-bucketed against the fresh baseline,
that invalid-wasm bucket is **0**; reproducing the named sample tests now yields
an assertion failure, not an instantiate error. Acceptance #1 (no invalid wasm)
is met → closed.

The residual **~86 fails** (down from 325) are a **distinct architectural
problem** — async `yield*` execution-order / laziness, rooted in the eager-buffer
generator runtime (`src/runtime.ts:135`, the same root as **#2566**). Re-filed as
**#2570** (lazy/suspending async-generator runtime). Not part of this issue's
invalid-wasm scope.

# async-generator `yield*` emits invalid Wasm (array.set in generated closure)

## Problem

Harvested from the default (JS-host) lane on 2026-06-04 (run `4ee32a3e`):
**325 official tests** fail at `WebAssembly.instantiate` with an invalid binary,
all in the async-generator `yield*` (delegation) family. The malformed
instruction is an `array.set` inside a compiler-generated closure function.

Representative error (default lane):

```
L60:21 invalid Wasm binary (WebAssembly.instantiate(): Compiling function
#42:"__closure_4" failed: array.set[...] expected type ..., found ...)
```

## Sample tests (3)

- `test/language/expressions/async-generator/yield-star-async-next.js`
- `test/language/expressions/async-generator/yield-star-sync-throw.js`
- (broader `language/expressions/async-generator/yield-star-*` + statement forms)

## Root-cause hypothesis

The `yield*` delegation lowering for **async** generators generates a closure
(`__closure_N`) that performs an `array.set` whose value/element type does not
match the target array's declared element type — i.e. a type-mismatched store
emitted into the delegation driver closure. This is specific to the async
generator path (the sync `yield*` path is not in this cluster), suggesting the
async CPS/driver wrapper around the delegation loop boxes/stores the inner
iterator result with the wrong ValType.

Likely sites: the async-generator lowering + `yield*` delegation codegen
(generators-native / async CPS), where the per-step result is stored into the
generator state/result array.

## Suggested fix

1. Reproduce with one `yield-star-async-next.js`; dump the offending
   `__closure_N` and identify which `array.set` mismatches (element type vs
   value on stack).
2. Coerce the stored value to the array's declared element type at the store
   site (the standard `coerceType` boundary), or fix the array's declared
   element type if it should be wider.
3. Add `tests/issue-1887.test.ts` covering async `yield*` next/throw/return
   delegation.

## Acceptance

- The 325 `yield-star-async-*` instantiation failures compile to a valid binary
  and run.
- No regression in the sync `yield*` path or the async-generator microtask
  tests.

## Notes

NEW issue from /harvest-errors 2026-06-04. Default-lane (not standalone) — does
not bear on the standalone-57% push; tracked separately. Count at filing: 325.
