---
id: 1637
title: "spec gap: Boolean wrapper + Symbol coercion TypeErrors (24 + 45 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: types
goal: spec-completeness
sprint: 50
renumbered_from: 1343
parent: 1328
related: 1319
---
# #1343 — Boolean wrapper coercion + Symbol primitive coercion

## Problem

`built-ins/Boolean`: **27 / 51 (52.9%) — 24 fails (23 assertion_fail)**.
`built-ins/Symbol`: **53 / 98 (54.1%) — 45 fails (20 type_error, 18 assertion_fail)**.

Spec requirements:
1. **§20.3.3.2 Boolean.prototype.toString** — receiver coercion: must accept Boolean wrapper or
   primitive boolean, otherwise TypeError. The 23 assertion_fail tests expect "true"/"false"
   from `Boolean.prototype.toString.call(0)` etc. (per ToBooleanthisValue) — but we likely
   throw TypeError on primitive 0.

2. **§20.4.3 Symbol.prototype.toString / valueOf / [@@toPrimitive]**: must throw on string-hint
   coercion (Symbol cannot be implicitly converted to string except via explicit Symbol.prototype.toString).

3. **§20.4.1 Symbol.for / Symbol.keyFor**: maintain a global registry. Symbol.keyFor on a non-registered
   Symbol returns undefined.

Current state:
- Boolean.prototype.toString.call(prim) likely fails because we don't unbox via ToBooleanthisValue.
- Symbol→primitive in template literals/concatenation does not throw TypeError (#1319 partial).
- Symbol.for/keyFor: passes for simple cases but fails on cross-realm symbol identity tests.

## Acceptance criteria

1. `built-ins/Boolean/prototype/toString/this-val-non-boolean.js` passes.
2. `built-ins/Boolean/prototype/valueOf/this-val-boolean.js` passes.
3. `built-ins/Symbol/prototype/toString/symbol-thisvalue.js` passes.
4. `built-ins/Symbol/for/registry.js` passes.
5. `built-ins/Symbol/keyFor/symbol-not-in-symbol-registry.js` passes.
6. Pass-rate for `built-ins/Boolean` rises from 53% to ≥85%, Symbol from 54% to ≥75%.

## Files to modify

- `src/codegen/registry/boolean.ts` — Boolean prototype methods
- `src/codegen/registry/symbol.ts` — Symbol prototype methods
- `src/runtime.ts` — `__symbol_for`, `__symbol_key_for`

## Implementation Plan

### Root cause

Two distinct issues:

1. **Boolean.prototype methods on primitives**: receiver is `f64` (when called via `.call(0)`)
   but our method dispatch expects an externref Boolean wrapper. Solution: emit ToBooleanthisValue
   first, which unboxes wrapper or coerces primitive.

2. **Symbol coercion**: Symbol values are externref-tagged objects with a hidden brand. Our
   coercion paths (template-literal concat, ToString) don't check for the brand and end up
   calling __to_string which silently returns "Symbol()". Spec says ToString(Symbol) throws TypeError;
   ToPrimitive(Symbol, "string") also throws unless explicit toString().

### Approach

For Boolean:
```
function compileBooleanToString(receiver) {
  // §20.3.3.2 step 1: b = thisBooleanValue(this)
  // - if Boolean wrapper → unbox
  // - if primitive boolean → use as-is
  // - else → TypeError
  emit BooleanThisValue dispatch + select "true"/"false".
}
```

For Symbol coercion:
- In ToString and template-literal concat, emit `ref.test $SymbolBrand` before the host call;
  if true, throw TypeError("Cannot convert Symbol to string").

### Edge cases

- `Boolean.prototype.toString.call(undefined)` → TypeError.
- `String(Symbol("x"))` (explicit String()) → "Symbol(x)" per spec — explicit OK, implicit not.
- Template literal `${sym}` → TypeError.

### Test262 sample

- `test262/test/built-ins/Boolean/prototype/toString/this-val-non-boolean.js`
- `test262/test/built-ins/Symbol/prototype/toString/symbol-thisvalue.js`
- `test262/test/built-ins/Symbol/for/registry.js`

## Test Results (2026-05-27, dev-1606 worktree)

Smoke-tested against current main (`6d5a806d0`) — the architect's referenced
files (`src/codegen/registry/boolean.ts`, `registry/symbol.ts`) **do not exist**
on main; the live coercion code is in `src/codegen/string-ops.ts`,
`src/codegen/expressions/calls.ts`, and `src/runtime.ts`.

**Boolean wrapper coercion already works on main** — `Boolean.prototype.toString.call(0)`
→ `"false"`, `(new Boolean(0)).toString()` → `"false"`, transferring to a String
object throws TypeError. No Boolean change needed.

**Symbol implicit string coercion was the real gap.** Fixed in this PR:
- template-literal substitution `` `${Symbol()}` `` now throws TypeError (§7.1.17 ToString(Symbol)).
- `str + Symbol` / `Symbol + str` concatenation now throws TypeError.
- `Symbol.for(symbolKey)` now throws TypeError (ToString of a Symbol key).

Implemented as a static-type guard (`isSymbolType`) at the three implicit-coercion
sites, mirroring the pre-existing `Number(Symbol)` / numeric-arg TypeError guards.

Out of scope (left for a follow-up — requires routing symbol i32 ids through
`__box_symbol` + host toString): explicit `String(Symbol("x"))` and
`Symbol("x").toString()` returning `"Symbol(x)"`; these are correctness gaps but
not implicit-coercion throws.

New test: `tests/issue-1637.test.ts` (6 cases, all pass). Non-Symbol concat/template
paths verified unchanged. The 2 `issue-958-concat-chain` WAT-assertion failures and
`helpers.js`/`__box_number` harness errors reproduce identically on origin/main —
pre-existing, not caused by this change.
