---
id: 2054
title: "Math.max(...arr) / Math.min(...arr) on runtime arrays silently return NaN — generic SpreadElement passthrough hazard"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: spread
goal: core-semantics
related: [18, 1135, 2053]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #2054 — `Math.max(...arr)` returns NaN; SpreadElement transparently unwrapped

## Problem

The extremely common idiom `Math.max(...arr)` compiles with zero diagnostics and
returns NaN. Beyond the Math builtin, the root pattern is a general hazard: the
expression dispatcher silently unwraps any `SpreadElement` to its inner
expression, so every call path without an explicit spread special-case compiles
"spread" as "pass the array itself, coerced".

## Repro (verified on main)

```ts
export function t4(): number {
  const arr: number[] = [3, 9, 4];
  return Math.max(...arr);   // JS: 9
}
```

wasm: `NaN` — node: `9`. Zero diagnostics.

## Root cause

Two pieces:

1. `src/codegen/expressions/builtins.ts:2300-2306`: with
   `expr.arguments.length === 1`, the single argument (the `SpreadElement`) is
   compiled directly with an f64 hint.
2. `src/codegen/expressions.ts:1264-1266`:
   ```ts
   if (ts.isSpreadElement(expr as any)) {
     return compileExpressionInner(ctx, fctx, (expr as any as ts.SpreadElement).expression, expectedType);
   }
   ```
   The generic dispatcher transparently unwraps a SpreadElement, so
   `Math.max(...arr)` becomes `ToNumber(arr-as-f64)` → NaN.

Note: #18 (done) lists `Math.max(...numbers)` as a target case and #1135 (done)
claims `Math.max(...vec)` works via the host `__make_iterable` path — neither
holds on current main with the default compile path.

## Fix direction

In the Math.min/max builtin lowering, detect `SpreadElement` arguments and emit
a runtime loop over the vec (`length` field + `f64.max`/`f64.min` fold with NaN
guard and ±Infinity empty-array result), or route to the host import in JS-host
mode (with a Wasm-native loop for standalone). Separately, the SpreadElement
passthrough in `compileExpressionInner` should `reportError` instead of silently
compiling the inner expression when the consumer didn't explicitly opt in —
that converts a whole class of future silent miscompiles into compile errors.

## Acceptance criteria

- `Math.max(...arr)` / `Math.min(...arr)` match Node, including empty array
  (`-Infinity` / `Infinity`) and NaN elements
- Mixed forms `Math.max(0, ...arr)` correct
- Unhandled SpreadElement positions produce a compile-time error, not silent
  coercion (audit existing intentional consumers before flipping)
- Works in both JS-host and standalone modes (no new host import without
  standalone fallback)

## Dupe check

Grepped `Math.max(...` across plan/issues/ — only #18/#78/#83/#1135/#1888, all
done, all asserting it works or planning it. No open issue for the current
breakage.

## Resolution (2026-06-11)

Added `compileMathMinMaxSpread` in `src/codegen/expressions/builtins.ts`,
dispatched from the Math.min/max lowering when any argument is a
`SpreadElement`. It folds the arguments left-to-right into an f64 accumulator
seeded with the identity (`+Infinity` for min, `-Infinity` for max):

- positional numeric args compile to f64 and fold via `f64.min`/`f64.max`;
- each spread resolves its backing vec through `resolveArrayInfo`, then a native
  WasmGC loop reads `struct.get fieldIdx 0` (length) / `fieldIdx 1` (data) and
  folds each `array.get` element (i32 elements promoted via `f64.convert_i32_s`);
- NaN is tracked in a flag and propagated to the result via `select`
  (§21.3.2.24/25 — result is NaN if any value is NaN);
- a null vec contributes nothing (guarded by `ref.is_null`).

Pure WasmGC, no host import, so it works in both JS-host and standalone modes.
When a spread's element type cannot be resolved to a numeric native vec
(externref element, etc.) the helper returns null and the caller keeps the
legacy behaviour rather than emitting invalid Wasm.

**Deferred**: the broader "make the SpreadElement passthrough in
`compileExpressionInner` `reportError` instead of silently unwrapping" hardening
(acceptance bullet 3) is intentionally NOT done here — it risks regressing
legitimate consumers and needs the audit the issue itself calls for. This PR
fixes the concrete Math.max/min breakage; the passthrough-to-error change should
be a separate, audited issue.

### Test Results

New `tests/equivalence/math-minmax-spread.test.ts` — 10 cases (simple max/min,
empty `±Infinity`, leading/trailing/both-sides positional, NaN propagation,
multiple spreads, all-negative). All pass. `Math.max(...[3,9,4])` now returns
`9` (was NaN). No regressions in math-builtins / new-expression-spread /
spread-in-new-expressions / sparse-array-spread (40 tests green).
