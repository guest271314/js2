---
id: 2896
title: "Standalone: native function-object metadata + property descriptors (.name/.length, getOwnPropertyDescriptor) — blocks builtin static-method value-read cluster"
status: ready
created: 2026-06-30
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
goal: standalone
related: [2861, 2863, 2175, 2193]
umbrella: 2860
needs: architect-spec
---

# Standalone: native function-object metadata + property descriptors

## Problem

In `--target standalone`, the native function/method-closure value objects
(`$NativeMethodClosure` / builtin static-method closures materialized by
`ensureStandaloneBuiltinStaticMethodClosure`, `ensureStandaloneNativeMethodClosure`)
do **not** carry faithful function-object metadata:

- `fn.name` does not resolve to the spec name (returns `0`/empty).
- `fn.length` does not resolve to the spec arity (folds to `0`).
- `Object.getOwnPropertyDescriptor(fn, "name" | "length")` returns nothing
  (the reflective descriptor path sees no property), so the standard
  attributes `{ writable:false, enumerable:false, configurable:true }` are
  not observable.

This is true **even for already-wired methods** (verified against the control
`Array.isArray`, which has a registered static closure):

| read (standalone)                                    | result |
| ---------------------------------------------------- | ------ |
| `typeof Array.isArray === "function"`                | ✅ 1   |
| value-call `let f = Array.isArray; f([1,2])`         | ✅ 1   |
| `new (Array.isArray)()` throws (not-a-constructor)   | ✅ 1   |
| `Array.isArray.name === "isArray"`                   | ❌ 0   |
| `Array.isArray.length === 1`                         | ❌ 0   |
| `[[1],2].filter(Array.isArray)` (pass as callback)   | ❌ 0   |
| `getOwnPropertyDescriptor(Array.isArray,"name")`     | ❌ 0   |

## Why it matters

test262's `propertyHelper.js` (`verifyProperty`) — used by essentially every
builtin's `name.js`, `length.js`, and `prop-desc.js` — reads metadata through
the **reflective** path `Object.getOwnPropertyDescriptor(fn, "name")` and checks
the full attribute set, NOT a direct `fn.name === "x"` access. Because the
native closures expose no descriptor-visible `name`/`length` property, those
tests fail (or CE) regardless of any direct-access meta-fold.

This is the substrate blocker behind the **builtin static-method value-read
cluster** (#2861 residual / #2863 Phase 1): direct *calls* of builtin static
methods already work host-free (`Number.isInteger(5)`, `ArrayBuffer.isView(...)`),
and bare value-reads can be wired per-method — but per-method wiring flips only
the `not-a-constructor.js`-style test each, while `name.js`/`length.js`/
`prop-desc.js` (the bulk per builtin) stay red until the function-object
metadata/descriptor substrate exists.

## Scope (BROAD SHARED INFRA — not per-method wiring)

This is **shared infrastructure**, deliberately filed separately from the
per-builtin value-read wiring in #2861/#2863:

- Native function/closure values need a uniform, descriptor-visible
  `name` (string) and `length` (number) with the spec attributes
  (`writable:false, enumerable:false, configurable:true`).
- `getOwnPropertyDescriptor` / `getOwnPropertyNames` over a native function
  value must surface these own properties.
- Callback-passing of a native method value must invoke it correctly
  (the `filter(Array.isArray)` control returns 0 today).
- Overlaps the existing direct-access meta-fold
  `tryCompileStandaloneBuiltinProtoMemberMeta`
  (`src/codegen/property-access.ts:861`), which folds
  `<Builtin>.prototype.<member>.name`/`.length` to constants but does NOT
  satisfy the reflective descriptor path (verified: the descriptor read still
  returns 0 for `String.prototype.charAt.name`). The substrate fix should
  subsume / align with that fold rather than duplicate it.

## Where to look

- `src/codegen/property-access.ts`:
  - `ensureStandaloneBuiltinStaticMethodClosure` (line ~954) — static-method
    closures (only `Array.isArray`, `Object.keys`,
    `Object.getOwnPropertyDescriptor` wired).
  - `ensureStandaloneNativeMethodClosure` / `tryEnsureNativeProtoBrand`
    (line ~704) — brand-keyed proto method/getter closures.
  - `tryCompileStandaloneBuiltinProtoMemberMeta` (line ~861) — existing
    direct-access `.name`/`.length` fold (does not cover descriptors).
  - `makeBuiltinClosureFctx` (line ~644) — the closure struct shape; a
    `name`/`length` carrier would attach here.
- The standalone `$Object` / native value-read substrate for how an externref
  function value answers `getOwnPropertyDescriptor` / member reads.

## Acceptance

- `Object.getOwnPropertyDescriptor(fn, "name")` / `(fn, "length")` over a native
  builtin function value returns the spec value + `{writable:false,
  enumerable:false, configurable:true}`.
- test262 `built-ins/**/{name,length,prop-desc}.js` flip to **pass** host-free
  for the wired builtin functions (and unblock the #2861/#2863 static-method
  value-read cluster once individual methods are wired).
- Passing a native method value as a callback invokes it correctly.
- gc (JS-host) mode unchanged; standalone-gated; full `merge_group` +
  standalone high-water, net-positive, zero host-mode regression.

## Notes

Filed from the 2026-06-30 verify-first sweep (sr-genframe) that concluded the
cheap ungated host-free CE→pass lane is near-exhausted and the standalone gap is
now substrate-bound. **feasibility: hard — needs an architect spec before dev
work** (function-object metadata model + descriptor visibility over the
standalone value substrate). Do not pick up as a bare per-method wiring task.
