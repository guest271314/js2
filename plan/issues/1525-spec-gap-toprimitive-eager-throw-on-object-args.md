---
id: 1525
title: "spec gap: built-in coercion paths throw 'Cannot convert object to primitive value' eagerly"
status: ready
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: to-primitive, abstract-operations
sprint: 52
es_edition: ES2024
test262_category: multiple (Array, String, DataView, Boolean, equality)
test262_count: 170
related: [1253, 1129, 1434]
---
# #1525 — `Cannot convert object to primitive value` raised too eagerly

## Problem

170 tests fail at runtime with:

```
L41:3 Cannot convert object to primitive value
```

The error originates in our `ToPrimitive` host import / runtime path
when the receiver is an exotic / extern-wrapped object. Per spec
(§7.1.1) `ToPrimitive(input, hint)` must:

1. call `@@toPrimitive` (Symbol.toPrimitive) if present,
2. otherwise call `OrdinaryToPrimitive(input, hint)`,
3. which tries `valueOf` then `toString` (or reverse for hint `string`),
4. and only throws `TypeError` if **both** return objects.

We appear to throw immediately when the user object does not have a
native `Symbol.toPrimitive` slot, instead of falling through to the
ordinary path. That regresses any `==`, arithmetic coercion, or
`ToInteger`/`ToIndex` call against an exotic receiver.

## Failing test examples

- `test/language/expressions/does-not-equals/S11.9.2_A4.1_T1.js` — `obj != 0` coercion
- `test/built-ins/Array/prototype/indexOf/15.4.4.14-10-1.js` — `indexOf` against a primitive-wrapped receiver
- `test/built-ins/Array/prototype/reduce/15.4.4.21-9-c-ii-2.js` — reducer return value coerced
- `test/built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T2.js` — Boolean wrapper toString
- `test/built-ins/DataView/prototype/setInt8/toindex-byteoffset.js` — `ToIndex(byteOffset)`

Note: distinct from #1253 (`OrdinaryToPrimitive` returning `undefined`
instead of throwing), which is the *opposite* failure mode.

## Approach

1. Audit `src/runtime.ts` and any `__toPrimitive` import or builtin
   for early-throw paths.
2. Make the fallback walk `valueOf` then `toString` (or reverse for
   `string` hint) and only throw when both return objects.
3. Make sure `Symbol.toPrimitive` lookup tolerates absent slot
   without raising.

## Acceptance criteria

- The five example tests reach the assertion phase, with at least 100
  of the 170 cluster tests flipping CE/runtime-error → pass or
  assertion-fail.
- No regression in the existing `ToNumber/ToNumeric` tests covered by
  #1434.

## Estimated impact

**~170 test262 tests**, distributed across Array, String, DataView,
Boolean, equality operators.

## Investigation 2026-05-27 (dev-1593)

Re-baselined on current main. The `Cannot convert object to primitive`
cluster is **150** failing entries. It decomposes into **three independent
root causes**, not one runtime-walker fix:

1. **`new Object()` / `Object()` → null-prototype object [FIXED here].**
   Both forms were lowered to `__object_create(null)` (→ `Object.create(null)`),
   which has no `Object.prototype.toString`/`valueOf`. Any ToPrimitive
   coercion (`==`, arithmetic, `String(...)`) on the result threw instead of
   producing `"[object Object]"`. Per §20.1.1.1 `new Object()` must inherit
   the ordinary `Object.prototype`. Fix: lower both via `__new_plain_object`
   (the path `{}` literals already use) — `src/codegen/expressions/new-super.ts`
   and `src/codegen/expressions/calls.ts`. Verified: `NaN != new Object()` no
   longer throws; `language/expressions/does-not-equals/S11.9.2_A4.1_T1.js`
   PASSES; `Boolean(new Object())` is `true`. tsc clean.

2. **Object-literal with user `toString`/`valueOf` coerced via `String(obj)`
   / `String.prototype.trim*` / `charAt` etc. [NOT fixed — the dominant ~142].**
   These throw because the object-method trampoline + `__extern_toString`
   path can't dispatch the user method. The concrete failure is invalid Wasm
   in `finalizeMethodTrampolines` (`src/codegen/closures.ts`): the result
   coercion emits a double `f64.convert_i32_s` (`expected i32, found f64`)
   when the wrapper/method result kinds drift. This is a hard codegen effort
   overlapping #1602/#1669 (trampoline signature drift) and the host
   struct-method dispatch in #1130/#983. **Recommend carve to a new issue
   (#1525b) with an architect spec.**

3. **§7.1.1.1 step-6 TypeError when both `valueOf` and `toString` return
   objects [NOT fixed].** Currently bottoms out instead of throwing.

Note: `tests/issue-1525.test.ts` already existed on main (old TaskList #14
was marked "completed" but the source fix never landed) — 8/10 pass, the 2
failing cases are bugs #2 and #3 above.
