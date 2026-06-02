---
id: 1729
title: "instanceof Object returns false for WasmGC-struct values (object literal / array / class instance / thrown value)"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: medium
feasibility: easy
task_type: bugfix
area: codegen
language_feature: instanceof, prototype-chain
goal: test262-conformance
related: [1455, 1366, 1720]
---
# #1729 — `instanceof Object` false for struct-backed values

## Problem

`<value> instanceof Object` returned **false** for compiler-native
WasmGC-struct values — object literals, arrays, class instances — and for a
caught thrown value (the #1720 `A6_T1` first-assertion that dev-c surfaced):

```js
const o = { x: 1 };       o instanceof Object        // was false (expected true)
const a = [1, 2];         a instanceof Object        // was false
class C {}                new C() instanceof Object  // was false
try { throw { x: 1 }; } catch (e) { e instanceof Object } // was false
```

Per §7.3.20 OrdinaryHasInstance, every object's prototype chain reaches
`Object.prototype`, so `instanceof Object` is true for all of them.

## Root cause

WasmGC-struct values are opaque externrefs at the host boundary. Two layers
returned a spurious `false`:

1. **Static evaluator** `tryStaticInstanceOf` (`identifiers.ts`): for an
   object-literal LHS it fell through to `undefined` (runtime); for an array
   LHS (`Array` symbol) it hit `isBuiltinSubtype("Array","Object")` → false
   (no Array→Object chain edge); for a user-class instance it returned `false`
   (no builtin parent).
2. **Runtime** `__instanceof` (`runtime.ts`): `v instanceof globalThis.Object`
   is false for an opaque struct externref, so the `any`-typed / thrown-value
   path returned 0.

## Fix (localized)

- `tryStaticInstanceOf`: `ctorName === "Object"` is a universal yes for
  (a) builtin-symbol LHS, (b) user-class-instance LHS (no builtin parent),
  and (c) any provably non-primitive object type (object literals / arrays /
  tuples). Guarded against primitives / null / undefined / any / unknown.
- `__instanceof`: a non-null WasmGC-struct receiver with the `Object` RHS
  returns 1 (covers the `any`-typed / thrown-value path). Primitives never
  reach this branch as wasm structs, so `5 instanceof Object` stays false.

Spec: ECMA-262 §7.3.20 OrdinaryHasInstance, §20.1.3.

## Acceptance criteria

- Object literal / array / class instance / thrown object / thrown array
  `instanceof Object` → true. ✅
- Thrown number / string `instanceof Object` → false. ✅
- `array instanceof Array` still true; `obj instanceof Array` still false;
  `Error instanceof Error` / `instanceof Object` still true. ✅
- No regression in #1455 / #1366a / #1366b instanceof suites (24/24 pass).

## Test Results

- `tests/issue-1729.test.ts` — 9/9 pass.
- `tests/issue-1455.test.ts` + `issue-1366a` + `issue-1366b` — 24/24 (no regression).
- (`tests/instanceof.test.ts` fails 7/7 on a CLEAN checkout too — a pre-existing
  harness issue unrelated to this change; user-class↔user-class instanceof is
  untouched here.)

## Source

dev-b, from the #1720 A6_T1 instanceof-on-thrown-value gap (dev-c). Sprint 57.
