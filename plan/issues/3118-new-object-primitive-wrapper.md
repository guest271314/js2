---
id: 3118
title: "new Object(primitive) ignores its argument — must ToObject to the Number/String/Boolean/BigInt wrapper (§20.1.1.1)"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3058
model: fable
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: object-wrapper, tojobject
es_edition: ES2015
test262_category: built-ins/Object
goal: conformance
sprint: 71
horizon: s
created: 2026-07-09
related: [1129, 1110]
---

# `new Object(primitive)` ignores its argument

## Problem (verify-first, main realm, 2026-07-09)

The `new Object(...)` codegen path (`src/codegen/expressions/new-super.ts`,
the `expr.expression.text === "Object"` arm) unconditionally emitted
`__new_plain_object` and **dropped its argument**. So `new Object(42)` produced
an empty object rather than a Number wrapper:

```ts
String(new Object(42)); // "[object Object]"  — should be "42"
new Object(42).valueOf(); // null               — should be 42
const i: any = new Object(42);
i.charCodeAt = String.prototype.charCodeAt;
i.charCodeAt(0); // 91 (reads "[object Object]"[0]) — should be 52
```

The **called** form `Object(42)` was already correct (`tryObjectCoercionCall`
in `calls-guards.ts`, #1129) — it ToObject-boxes a primitive to its wrapper.
Per §20.1.1.1 the `new` and call forms are spec-identical (both return
`ToObject(value)` for a non-null/undefined value), so the two paths diverged.

This is the genuine root of the S15.5.4.x String "method borrowed onto a boxed
primitive" cluster (`__instance = new Object(42); __instance.charCodeAt =
String.prototype.charCodeAt; …`) plus the Object/Function/RegExp variants.

Discovered while harvesting the gc-lane long-tail for #3058's Fable window (the
String/prototype cluster is otherwise scattered + dominated by CI vm-sandbox
realm artifacts — see the #1310 note in the sprint log; this is the one clean,
main-realm-reproducible, self-contained root in it).

## Fix

Unify both forms on one ToObject helper. Extracted the body of
`tryObjectCoercionCall` into a shared exported `emitObjectCoercion(ctx, fctx,
args)` (`calls-guards.ts`) — the call-form wrapper now just does the
`Object`-identity check then delegates, so its output is **byte-identical**.
The `new Object(...)` arm in `new-super.ts` now delegates to the same helper:

- primitive arg → `__new_Number` / `__new_String` / `__new_Boolean` /
  `__new_BigInt` native wrapper (already standalone-capable, object-runtime.ts);
- object arg → identity (returned unchanged);
- null / undefined / no-arg → `__new_plain_object` (unchanged behavior).

## Blast radius (measured, worktree runner = branch compiler, 2026-07-09)

Of the 32 baseline fails that exercise `new Object(primitive)` / `Object(prim)`,
**18 flip fail→pass** with the fix:

- 14 × `String/prototype/*` (charAt, charCodeAt, concat, indexOf, lastIndexOf,
  match, replace, search, slice, substring, toLowerCase, toUpperCase,
  toLocaleLowerCase, toLocaleUpperCase — the S15.5.4.x borrow tests);
- 2 × `RegExp` (S15.10.4.1_A8_T9, exec/S15.10.6.2_A1_T3);
- 1 × `Object/prototype/valueOf/S15.2.4.4_A1_T2`;
- 1 × `Function/S15.3.2.1_A1_T7`.

The remaining 13 fails + 1 pre-existing `compile_error`
(`Array/prototype/toString/non-callable-join-string-tag.js`, unchanged on main)
have DIFFERENT roots (BigInt==Object comparison, Object constructor
same-value edge cases, Object.prototype.valueOf on a wrapper) — out of scope.

## Guards

- Byte-inert for programs that never call `new Object(...)`: verified by
  compiling the playground corpus with vs without the change — **byte-identical**
  (26 host+standalone compiles). The call-form refactor is a pure extraction
  (identical emitted code).
- Edge cases verified: `new Object()`→plain object, `new Object(obj)`/`(arr)`→
  identity, `new Object(null)`→fresh object, `new Object(<var number>)`→"…",
  `Object(7)` call unchanged.
- Wrapper/coercion equivalence suites green (36 tests across wrapper-constructors,
  #1910 boolean/string wrapper, #1910d loose-eq, #2029 subclass).

## Acceptance criteria

- `new Object(primitive)` returns the matching wrapper; `String(new Object(42))
=== "42"`, `new Object(42).valueOf() === 42`, method-borrow reads the boxed
  primitive's string. ✅
- Zero regressions; byte-inert for non-`new Object` programs. ✅
- The 18 floor-visible test262 flips confirmed via the branch compiler. ✅

## Notes

`emitObjectCoercion`'s `any`-typed-primitive-arg fallthrough returns the arg by
identity (can't statically prove primitive-vs-object) — this matches the
pre-existing call-form limitation (`Object(anyVar)` typeof may read the
primitive's type, not "object"). Out of scope; a runtime `__to_object` helper
would close it (noted in calls-guards.ts).
