---
id: 2587
title: "compiler stack-overflow on nested object-pattern-with-default destructuring param in a (static) class method"
status: ready
sprint: Backlog
created: 2026-06-21
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring, classes
related: [2040, 2545, 2568]
origin: "2026-06-21 sd-3 — found while diagnosing #2040 cluster A. Confirmed PRE-EXISTING on clean origin/main (NOT caused by the #2040 equality work). Likely the source of several of the 13 wasm_compile entries in the #2040 floor run."
---

# #2587 — stack-overflow compiling a nested obj-pattern-default destructuring param in a class method

## Problem

A class method whose parameter is a **nested object binding pattern with a
default initializer** crashes the COMPILER with infinite recursion:

```ts
class C {
  static method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } }: any): number {
    return x as number;
  }
}
```

Compiling this (any target) fails with:

```
Internal error compiling expression: Maximum call stack size exceeded
```

Confirmed on **clean `origin/main`** (not introduced by the #2040 equality work).
The shape is exactly the test262 `class/dstr/*obj-ptrn*-init*` family
(`meth-static-obj-ptrn-prop-obj.js`, `gen-meth-static-dflt-obj-ptrn-*`, …), so
this is very likely the source of several of the **13 `wasm_compile`** regressions
that appeared in the #2040 merge_group floor run (those files compile_error
rather than run).

## Suspected site

The nested-pattern-with-initializer arm of the parameter-destructuring lowering:
`src/codegen/destructuring-params.ts:~523-534` — the `__ext_dparam_nested_*`
recursion (`destructureParamObjectExternref` / `destructureParamArray` recursing
into the nested pattern) combined with the `element.initializer` default-eval
+ `ctx.liveBodies` body-swap window. The recursion does not bottom out for a
nested object pattern that itself carries a default object literal whose fields
are again bindings — the default-eval re-enters the same nested-pattern compile.

## Suggested approach

1. Build the minimal repro above and bisect which recursion (the nested-pattern
   descent, the default-initializer compile, or the `liveBodies`/body-swap
   re-entry) fails to terminate.
2. Add a visited-set / depth guard, or restructure so the default-initializer is
   compiled ONCE into a temp and the nested pattern destructures the temp (not
   re-entering the param-pattern compile).
3. Verify the `class/dstr/*obj-ptrn*-init*` test262 cluster compiles
   (no `compile_error`), and that `meth-static-obj-ptrn-prop-obj.js` runs.

## Acceptance criteria

- `static method({ w: { x, y, z } = {...} })` compiles (no stack-overflow), host
  and standalone.
- The `class/dstr/*obj-ptrn*-{prop,elem}-*-init*` cluster no longer
  `compile_error`s.
- No regression in the existing destructuring suites.
