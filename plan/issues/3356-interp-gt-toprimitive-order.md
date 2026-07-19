---
id: 3356
title: "interp: `>`/`>=` run ToPrimitive in reversed order (swap-desugar is LeftFirst=true) + #3310 byte-identical comment is inaccurate"
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-review
created: 2026-07-17
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: interp, codegen
language_feature: relational-operators
goal: runtime-eval
sprint: 72
# (#3102/#3131) +5-line growth is the #3310 comment correction itself — a note
# about fillApplyClosure's measured byte cost (+114 B/standalone module) cannot
# live anywhere except at that code, so "move to a subsystem module" does not
# apply. Replacing a factually wrong "byte-identical" claim is what the
# allowance exists for.
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

# interp: `>`/`>=` ToPrimitive coercion order + #3310 comment fix

Findings from the 2026-07-17 fable review pass over the merged #3101/#3310/#3311
implementations.

## Problem 1 — `>`/`>=` coerce operands in reversed order (spec bug)

`55c8a1ff` (#3101 follow-up) fixed the operand **evaluation** (GetValue) order
for `>`/`>=`, but the desugar `a > b → Lt(b, a)` (native `b < a`) still runs
**ToPrimitive** in the wrong order. Per ES2024:

- §13.10.1 (Relational Operators, Runtime Semantics): `a > b` evaluates
  `IsLessThan(rval, lval, LeftFirst: FALSE)`.
- §7.2.13 (IsLessThan): when `LeftFirst` is false, `py = ToPrimitive(y)` runs
  **before** `px = ToPrimitive(x)` — the flag exists precisely so observable
  coercion (valueOf/toString) stays in source order (a first, then b).

Native `b < a` is `IsLessThan(b, a, LeftFirst: TRUE)` → coerces **b first**.

Repro (interp said `"ba"`, native/eval says `"ab"`, for both `>` and `>=`;
`<`/`<=` were correct):

```js
var s = "";
var a = {
  valueOf: function () {
    s += "a";
    return 1;
  },
};
var b = {
  valueOf: function () {
    s += "b";
    return 2;
  },
};
a > b; // spec: s === "ab"; interp before fix: "ba"
```

### Fix

Dedicated `Gt`/`Ge` opcodes (appended at 37/38 to keep ids stable) backed by
`anyGt`/`anyGe` in `runtime-ops.ts` — native `a > b`/`a >= b` carry
`LeftFirst: false` by construction, per the #3101 design rule that all
coercion lives in the generic runtime helpers. The `emitSwapped` desugar is
removed; `>`/`>=` route through the standard left-in-register `emitBinary`
path. NaN (`IsLessThan` undefined → false) and string/mixed arms are locked by
tests.

## Problem 2 — #3310 "byte-identical" comment inaccurate (doc fix)

`fillApplyClosure`'s comment claimed widening the arity chain 4→8 "is
byte-identical without ≥5-arg closures". Measured (probe, 2026-07-17): the
guard scaffold of an unregistered arm is still emitted (~11 B/arm); a
representative standalone module grew **+114 B** (live n=5 arm — the runtime
always registers an arity-5 internal closure — plus 3 dead arms at +33 B).
Host/gc modules are genuinely unaffected (`__apply_closure` is only reserved
under standalone/wasi; verified empirically and by call-site audit). Comment
corrected in place; the dead-arm scaffold itself is left as-is (a
skip-dead-tail optimization is possible but not worth the churn at ~33 B).

## Test Results

- `tests/interp/fixtures.test.ts` — 2 new ToPrimitive-order tests FAIL before
  the fix, pass after; NaN/string arms added as regression locks.
- `tests/interp/differential.test.ts` — 2 new CURATED bodies (interp vs eval).
- Full `tests/interp/` suite: 128/128 pass with the fix.
