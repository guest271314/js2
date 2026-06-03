---
id: 1720
title: "ES3: prefix/postfix inc-dec reference is evaluated once before the null/undefined deref ('base[prop()]++')"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: update-expression-reference-eval-order
goal: test262-conformance
sprint: 57
es_edition: 0
test262_fail: 10
test262_category: language/expressions/postfix-increment, postfix-decrement, prefix-increment, prefix-decrement
related: [1379]
---
# #1720 — ES3: UpdateExpression reference evaluated exactly once, before deref

## Problem (edition ≤ ES3, sputnik S11.x)

The legacy sputnik tests `S11.3.1_A6`, `S11.3.2_A6`, `S11.4.4_A6`, `S11.4.5_A6`
(postfix-increment, postfix-decrement, prefix-increment, prefix-decrement) fail
(`returned 2` — the assertion `assert.throws(DummyError, …)` did not see the
expected error). Pattern:

```js
function DummyError() {}
assert.throws(DummyError, function () {
  var base = null;
  var prop = function () { throw new DummyError(); };
  base[prop()]++;          // prop() must run (and throw DummyError) FIRST
});
assert.throws(TypeError, function () {
  var base = null;
  var prop = { toString() { throw new Test262Error("evaluated"); } };
  base[prop]++;            // GetValue(base) throws TypeError before ToPropertyKey
});
```

This is distinct from #1379 (`done`, "unary inc/dec on null/undefined/string"),
which fixed the *value/type* coercion of inc/dec. The gap here is the
**evaluation order of the reference**: the MemberExpression operand must be
evaluated exactly once (§13.4.x UpdateExpression → §13.3.3
EvaluatePropertyAccessWithExpressionKey), so `prop()` runs and throws before any
null-deref, and in the second case the base GetValue throws TypeError before the
property key is coerced.

Spec: [§13.4.2 Postfix Increment](https://tc39.es/ecma262/#sec-postfix-increment-operator),
[§13.4.4 Prefix Increment](https://tc39.es/ecma262/#sec-prefix-increment-operator),
[§13.3.3 EvaluatePropertyAccessWithExpressionKey](https://tc39.es/ecma262/#sec-evaluate-property-access-with-expression-key).

## Root-cause hypothesis

Our codegen lowers `base[prop()]++` by emitting the null-base check (or a fast
trap) before fully evaluating the computed key expression `prop()`, so the
DummyError thrown inside `prop()` is shadowed by our own null-deref handling /
the operation returns the wrong completion. The reference must be fully
evaluated (computed key included) and `GetValue` attempted in spec order.

## Example failing tests

- `test/language/expressions/postfix-increment/S11.3.1_A6_T1.js`
- `test/language/expressions/postfix-increment/S11.3.1_A6_T2.js`
- `test/language/expressions/prefix-increment/S11.4.4_A6_T1.js`
- `test/language/expressions/prefix-decrement/S11.4.5_A6_T1.js`
- `test/language/expressions/postfix-decrement/S11.3.2_A6_T1.js`

## Acceptance criteria

- All `S11.3.1_A6`, `S11.3.2_A6`, `S11.4.4_A6`, `S11.4.5_A6` (T1/T2) tests pass
  (≈ 10 tests).
- No regression in #1379's now-passing inc/dec tests.

## Source

Filed by product-owner test262 triage (ES3 / edition-0 view) 2026-05-29 against
main baseline (`.test262-cache/test262-current.jsonl`, 48,117 records).


## Implementation (landed)

### Root cause (confirmed)

`compileMemberIncDec` (`src/codegen/expressions/unary-updates.ts`) compiled the
base of an `ElementAccessExpression`, and when the base resolved to `externref`
(which is what a `null`-typed base produces) it took an early branch that
`drop`ped the base and emitted `f64.const NaN` — **without ever compiling the
property-key expression**. Two spec violations:

1. The key sub-expression's side effects (`prop()`) were lost — `prop()` never
   ran.
2. A `null` base produced `NaN` instead of throwing `TypeError`.

The sibling non-ref (numeric base) branch likewise skipped the key expression.

### Fix

In the externref element-access branch of `compileMemberIncDec`:

1. Save the base externref to a temp local.
2. Compile the property-key expression for its side effects, then `drop` it
   (ToPropertyKey itself is skipped — GetValue throws first on a null base).
3. Emit a runtime `ref.is_null` guard: null base → `emitThrowTypeError`
   (a real `TypeError` instance, satisfying `e instanceof TypeError`);
   non-null externref base → fall through to the existing `NaN` result.

The TypeError throw is emitted into the real `fctx.body` first (so
`emitThrowTypeError`'s late-import-shift bookkeeping patches the already-emitted
instructions correctly), then the freshly-appended throw instrs are spliced out
into the `if` then-body. Building the throw against a detached body skips the
index shift on prior instrs and emits an index-corrupt module.

The non-ref (numeric base) branch now also compiles the key for side effects
(a numeric base can't be null, so no TypeError path applies there).

### Test Results

`tests/issue-1720.test.ts` (11 cases) — all pass:

- property-key expression runs exactly once before the throw, for
  postfix/prefix x `++`/`--`
- null base throws (all four operators)
- null base throws a `TypeError` *instance* (not NaN)
- null base: key object's `toString` is NOT called (TypeError thrown first)
- non-null externref property inc/dec still yields NaN (unchanged)

Direct probe: `base[prop()]++` now invokes `prop()` once (was 0); the
`base[prop]++` null-base case throws TypeError with `toString` uncalled.

For the four `*_A6_T1.js` test262 files, the **second** assertion
(`assert.throws(TypeError, …)` + toString-not-called) now passes. The
**first** assertion (`assert.throws(DummyError, …)`) remains gated on a
separate, pre-existing gap: `e instanceof <userConstructor>` returns false for
a value thrown by `new DummyError()` (a non-Error user constructor). That
`instanceof` limitation is independent of update-expression evaluation order.

No regressions in the inc/dec suite (issue-260/378/319/1119/1379). The
pre-existing private-class-field failures (issue-254, issue-334 `this.#count++`)
reproduce identically on clean `main` HEAD and are unrelated (PropertyAccess
path, not ElementAccess).

### Files modified

- `src/codegen/expressions/unary-updates.ts` — externref + non-ref
  element-access branches in `compileMemberIncDec`.
- `tests/issue-1720.test.ts` — new.
