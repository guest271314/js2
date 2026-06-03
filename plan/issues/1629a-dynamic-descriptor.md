---
id: 1629a
title: "Object.defineProperty dynamic (non-literal) descriptor materialization"
status: done
created: 2026-05-28
updated: 2026-05-28
completed: 2026-05-28
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: Backlog
parent: 1629
owner: senior-developer
related: [1629, 1630, 1631, 1335]
---
# #1629a — Object.defineProperty dynamic descriptor materialization

> Sub-issue of #1629 (spec-gap descriptor attribute fidelity). Covers the
> dynamic (non-literal) descriptor argument case: when `desc` is a variable
> instead of an inline `{...}` literal at the `Object.defineProperty` call
> site. ~150 test262 fails in the plain-object subset.

## Problem

`Object.defineProperty(o, "foo", desc)` where `desc` is a variable (not an
`ObjectLiteralExpression`) silently dropped the entire descriptor on the floor.
The compile-time path in `compileObjectDefineProperty`
(`src/codegen/object-ops.ts`) extracted `value` / `get` / `set` / flags only
when the descriptor argument was an `ObjectLiteralExpression`. When it was a
variable, every extracted field was `undefined`, and the fall-through to
`emitExternDefinePropertyNoValue` then emitted `__defineProperty_value(obj,
"foo", null, flags=0)` — meaning:

- the data+accessor mix TypeError check fired with `hasData=false,
  hasAccessor=false` and silently passed;
- non-object descriptor coercion never ran;
- `value`, `get`, `set` never reached the runtime;
- the runtime call was outright skipped for typed-struct receivers because
  `isKnownStructField=true` shortcut elided it.

This made the entire `15.2.3.6-3-*` test262 cluster (~173 ToPropertyDescriptor
fails) and a slice of the `15.2.3.6-4-*` family unable to observe spec
invariants for the common pattern `var desc = {get, value}; defineProperty(o,
k, desc)`.

## Root cause

`compileObjectDefineProperty` in `src/codegen/object-ops.ts:576` parses the
descriptor argument as an AST literal. Every guard, attribute extraction,
type-mix check, and accessor compilation is gated on
`if (ts.isObjectLiteralExpression(descArg))`. The dynamic case has no inline
AST to extract from, and the fall-through path was implemented as
`__defineProperty_value(obj, k, null, 0)` — a value-less, flag-less, semantic
no-op.

The runtime already has the right helper: `__defineProperty_desc(obj, prop,
desc)` at `src/runtime.ts:4571` accepts an externref descriptor and
materializes its fields via a struct-aware `getField` that reads sidecar
properties AND falls back to the compiled module's `__sget_<f>` exports for
typed struct fields. This is the same path #1631 added for
`Object.create(proto, {k: descObj})` (a sibling dynamic-descriptor map case).
It just wasn't being invoked from `Object.defineProperty`.

## Fix

`src/codegen/object-ops.ts` — `compileObjectDefineProperty`: when `descArg`
is NOT an `ObjectLiteralExpression`, route to the runtime
`__defineProperty_desc(obj, prop, desc)` helper after coercing all three
arguments to externref. This applies uniformly whether the receiver is a
typed struct or a plain externref object; the runtime handles both via its
`getField` closure. Mirrors the structurally-identical `Object.create`
dispatch at `calls.ts:3996-4042` (#1631).

`src/runtime.ts` — extended `_toPropertyDescriptorValidate` with an optional
`wrapCallable` parameter and used it inside `__defineProperty_desc` to wrap
WasmGC-closure get/set into JS callables via `_maybeWrapCallable(..., 0/1,
callbackState)`. Without wrapping, the `typeof === "function"` invariant in
the validator threw "Getter must be a function" for WasmGC-struct
descriptors whose `get`/`set` fields were closures, not host functions.

## Acceptance criteria

1. `var desc = {get: <fn>, value: 99}; Object.defineProperty(o, "foo", desc)` —
   throws TypeError per §6.2.5.6 step 4. *(was: silently succeeded)*
2. `var desc = 42; Object.defineProperty(o, "foo", desc)` — throws TypeError
   per §10.1.6 step 1. *(was: silently succeeded)*
3. `Object.defineProperty(null, "foo", desc)` — throws TypeError per
   §19.1.2.4 step 1.
4. `Object.defineProperty(o, "foo", {value: 42, ...})` — inline-literal data
   path unaffected; returns 42 from `o.foo`. *(no regression)*
5. `#1630` (struct writeback) and `#1631` (Object.create descriptor map)
   tests continue to pass: 13/13 green across `tests/issue-1630.test.ts +
   tests/issue-1631.test.ts + tests/issue-1629a.test.ts`.
6. Equivalence tests `tests/equivalence/object-define-property.test.ts +
   tests/equivalence/object-to-primitive.test.ts` continue green: 11/11.

## Out of scope

- **Accessor read-back via `o.foo` after a dynamic accessor descriptor.** The
  receiver is typed as a WasmGC struct (e.g. `__anon_0`), so `o.foo = v` and
  `return o.foo` lower to `struct.get`/`struct.set` against the struct field.
  Writing through the descriptor's setter into a sidecar is invisible to
  subsequent struct.get reads. Tracked by **#1630** (descriptor-model
  writeback into struct fields) and **#1629b** (getOwnPropertyDescriptor
  attribute read-back for non-struct-field defined props).
- **Typed-struct field overwrite with a dynamic-descriptor data value.** The
  runtime helper stores via native Object.defineProperty (which falls back to
  the sidecar for WasmGC structs); subsequent compiled `struct.get` reads
  the original (default) field value. Resolves when #1630 lands the
  descriptor-model writeback.
- **15.2.3.6-4-* Array/Function exotic objects.** Distinct workstream
  (see #1629 investigation; covered separately under #1130 array semantics
  and the bound-function representation work).

## Files modified

- `src/codegen/object-ops.ts` — new dynamic-descriptor branch in
  `compileObjectDefineProperty` (~56 LOC), routes externref-coerced obj +
  prop + desc to `__defineProperty_desc`.
- `src/runtime.ts` — `_toPropertyDescriptorValidate` accepts an optional
  `wrapCallable`; `__defineProperty_desc` passes
  `(v, arity) => _maybeWrapCallable(v, arity, callbackState)` so WasmGC
  closure get/set fields satisfy the spec callable check.

## Tests added

- `tests/issue-1629a.test.ts` — 4 tests covering the four acceptance criteria
  (data+accessor mix throws, non-object desc throws, null receiver throws,
  inline-literal data path unaffected).
