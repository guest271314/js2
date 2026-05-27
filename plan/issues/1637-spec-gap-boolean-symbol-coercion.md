---
id: 1637
title: "spec gap: Boolean wrapper + Symbol coercion TypeErrors (24 + 45 test262 fails)"
status: in-progress
created: 2026-05-08
updated: 2026-05-27
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

## Resolution 2026-05-27 (dev-1606) — Boolean half fixed, Symbol half deferred

The architect's file paths (`src/codegen/registry/boolean.ts`,
`src/codegen/registry/symbol.ts`) are **stale** — those files do not exist on
main. The real code is `src/runtime.ts` (host imports) +
`src/codegen/string-ops.ts` / `binary-ops.ts` (concat lowering).

### Fixed: Boolean.prototype.toString/valueOf receiver coercion (~24 fails)

`Boolean.prototype.toString.call(0)` and `.valueOf.call(true)` previously threw
`TypeError: requires that 'this' be a Boolean`. `.call`/`.apply` on a
Boolean.prototype method routes through `__extern_method_call` (runtime.ts:4521),
which — unlike `__proto_method_call` (4785, #1342) — did not apply the
§20.3.3.{2,3} thisBooleanValue coercion. Boolean primitives arrive as numbers
(i32→externref via `__box_number`), so V8's native method rejected them.

**Fix** (runtime.ts, `__extern_method_call`): when `method` is `call`/`apply`
and the receiver function is `Boolean.prototype.{toString,valueOf}`, coerce a
numeric/bigint receiver arg back to a boolean primitive before dispatch.

Verified: `tests/issue-1637.test.ts` (5 cases) — toString.call(0)→"false",
.call(1)→"true", valueOf.call(true)→true, valueOf.call(false)→false,
toString.call(true)→"true". All pass.

### Deferred: Symbol→string implicit coercion (~45 fails) — NEEDS ARCHITECT RESPEC

`"v" + sym` returns `"v101"` and `String(sym)` returns `"101"` instead of
throwing/returning `"Symbol(x)"`. **Root cause is representational, not a
localized coercion bug**: Symbols are materialized as numeric (f64/i32) handles,
so binary-`+` concat lowers through `number_toString(handle)` (string-ops.ts
`compileAndCoerceConcatOperand`, the `valType.kind === "f64"` branch) and never
reaches the `__concat_*` host helper — which *already* throws on
`typeof === "symbol"` (#1342). A properly-typed Symbol operand currently even
emits a CompileError (`expected f64, found externref`), confirming the value
representation is inconsistent across the concat path.

A correct fix must make Symbol values flow as boxed externref (via
`__box_symbol`) through ToString sites so the runtime throw fires, OR add a
static-Symbol-type guard in `compileAndCoerceConcatOperand` that boxes +
routes through `__concat_*`. This spans concat codegen + Symbol representation
and is beyond the "easy" label. Recommend a follow-up sub-issue with an
architect spec on Symbol value representation at ToString boundaries.
