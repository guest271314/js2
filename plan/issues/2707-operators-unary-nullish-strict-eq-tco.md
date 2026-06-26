---
id: 2707
title: "operators: unary +/-/~/>>> null-deref on null/undefined; strict-equals # edge; TCO in ?:/&&/||"
status: ready
sprint: 67
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: ES3
language_feature: operators
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2707 — operators: unary null-deref on nullish, strict-equals edge, TCO through conditional/logical

## Problem

Three sub-bugs in operator codegen (BigInt and `with`-statement tests are excluded):

**(a) Unary `+` / `-` / `~` / `>>>` on null or undefined operands causes a null pointer dereference instead of coercing via ToNumber.** Per spec: `ToNumber(undefined) = NaN`, `ToNumber(null) = 0`. Tests `S11.4.6_A2.2_T1.js` (+null), `S11.4.7_A2.2_T1.js` (-null), `S11.4.8_A2.2_T1.js` (~null), `S9.6_A3.1_T4.js` (>>>null), `S9.5_A3.1_T4.js` (~undefined) all crash with "dereferencing a null pointer".

**(b) `strict-equals` / `strict-does-not-equals` edge: `false !== #`.** `S11.9.4_A8_T3.js`, `S11.9.4_A8_T2.js`, `S11.9.4_A8_T1.js`, `S11.9.5_A8_T3.js`, `S11.9.5_A8_T2.js`, `S11.9.5_A8_T1.js` — the `#` is a wasm function reference, and `false !== <funcref>` should be `true` (they are of different types) but our strict-equals emits incorrect results for the function-reference vs boolean case.

**(c) Tail-call optimization is not recognized in `?:` / `&&` / `||` / comma / labeled-block tail positions.** `conditional/tco-cond.js`, `conditional/tco-pos.js`, `logical-and/tco-right.js`, `logical-or/tco-right.js`, `comma/tco-final.js`, `labeled/tco.js` — these set a `callCount` and assert it equals 1 (the function calls itself recursively but TCO should prevent stack growth). The `return_call` opcode is not being emitted for tail calls in the consequent/alternate of `?:`, the RHS of `&&`/`||`, the **final operand of a comma expression** (`return 0, f(n-1)`), or a **labeled return** (`test262: return f(n-1)`). All five are the **same tail-call-position recognition gap** — `emitReturnTail` (`src/codegen/statements/control-flow.ts:340`) only rewrites the *last emitted* `call`/`call_ref` to `return_call`, so a call buried inside a conditional/logical/comma sub-expression or a labeled wrapper is never recognized — in additional syntactic contexts.

**Excluded (not in this issue):**
- BigInt tests (`unsigned-right-shift/bigint.js`, `bitwise-not/bigint.js`, `unary-minus/bigint.js`, etc.) → blocked on #2044 (BigInt i64-brand).
- `with`-statement-based tests (increment/decrement `scope.x===N` where `scope` is a `with` binding) → deferred/wont-fix.
- `emulates-undefined` annexB tests (`IsHTMLDDA`) → host-only feature, out of scope.
- `order-of-evaluation.js` (unsigned-right-shift) and `coalesce-expr-ternary.js` — possibly independent bugs; include only if non-with and non-bigint.

Spec: §7.1.4 ToNumber (null→0, undefined→NaN); §13.11 Strict Equality (===); §14.9.2 Tail Position Calls in ConditionalExpression, LogicalExpression.

## Failing tests (test262 baseline 2026-06-26)

### (a) Unary null-deref on nullish operands (~5 tests)

```
test/language/expressions/unary-plus/S11.4.6_A2.2_T1.js
test/language/expressions/unary-minus/S11.4.7_A2.2_T1.js
test/language/expressions/bitwise-not/S11.4.8_A2.2_T1.js
test/language/expressions/unsigned-right-shift/S9.6_A3.1_T4.js
test/language/expressions/bitwise-not/S9.5_A3.1_T4.js
```

### (b) Strict-equals # edge (~6 tests)

```
test/language/expressions/strict-equals/S11.9.4_A8_T3.js
test/language/expressions/strict-equals/S11.9.4_A8_T2.js
test/language/expressions/strict-equals/S11.9.4_A8_T1.js
test/language/expressions/strict-does-not-equals/S11.9.5_A8_T3.js
test/language/expressions/strict-does-not-equals/S11.9.5_A8_T2.js
test/language/expressions/strict-does-not-equals/S11.9.5_A8_T1.js
```

### (c) TCO through conditional, logical, comma, and labeled tail positions (~6 tests)

```
test/language/expressions/conditional/tco-cond.js
test/language/expressions/conditional/tco-pos.js
test/language/expressions/logical-and/tco-right.js
test/language/expressions/logical-or/tco-right.js
test/language/expressions/comma/tco-final.js
test/language/statements/labeled/tco.js
```

### Additional non-BigInt, non-with tests to confirm

```
test/language/expressions/unary-plus/S11.4.6_A3_T5.js
test/language/expressions/unary-minus/S11.4.7_A3_T5.js
test/language/expressions/unsigned-right-shift/order-of-evaluation.js
test/language/expressions/conditional/coalesce-expr-ternary.js
test/language/expressions/strict-does-not-equals/S11.9.5_A2.4_T2.js
test/language/expressions/strict-equals/S11.9.4_A2.4_T2.js
```

## Root cause (suspected)

**(a)** Unary operator codegen (`src/codegen/expressions.ts` UnaryExpression handler for `+`, `-`, `~`) emits a `f64.load` or externref field access on the operand before checking for null/undefined. The fix: coerce the operand first — `ToNumber(null) → f64.const 0`, `ToNumber(undefined) → f64.const NaN` — before applying the unary op. These should be handled in `coerceType` (already handles `null/undefined in f64 context: emit f64.const 0 / f64.const NaN` per CLAUDE.md).

**(b)** The strict-equals fast path probably checks type tags. A function reference (`#` in the test output = wasm funcref) against `false` (boolean) should short-circuit to `false !== false` → `true`. The bug may be that a funcref is misidentified as a falsy non-object.

**(c)** The TCO pass (`src/codegen/peephole.ts` or tail-call detection in `src/codegen/statements.ts`) looks for `ReturnStatement` with a `CallExpression`. In `ConditionalExpression` (`?:`) and `LogicalExpression` (`&&`, `||`), the tail call is inside a sub-expression, not directly under a `ReturnStatement`. The codegen needs to propagate the "is-tail-position" flag into conditional/logical branches.

## Acceptance criteria

At least 15 of the 21 listed non-BigInt, non-with tests flip from fail to pass (5 null-deref + 6 strict-equals + 4 TCO, adjusting for any that turn out to be with-based after inspection). No regression in operator tests. Full CI green.

## Notes

- BigInt operator tests (~8) are explicitly NOT in scope — they depend on #2044.
- `with`-based increment/decrement tests are wont-fix (the `with` statement is skip-filtered in our test runner).
- Postfix/prefix `11.3.x-2-3` wasm_compile errors: investigate first — include only if they are non-`with`.
- The `S11.4.6_A3_T5.js` / `S11.4.7_A3_T5.js` tests (unary on function result) — if they fail for a different reason than null-deref, note separately.
