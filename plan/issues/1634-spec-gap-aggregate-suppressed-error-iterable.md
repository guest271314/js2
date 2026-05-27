---
id: 1634
title: "spec gap: AggregateError + SuppressedError errors-iterable + cause coercion (37 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime, codegen
language_feature: error
goal: spec-completeness
sprint: 50
renumbered_from: 1340
parent: 1328
---
# #1340 — AggregateError / SuppressedError: errors iterable, cause option

## Problem

`built-ins/AggregateError`: **4 / 25 pass (16.0%)** — 9 type_error, 5 assertion_fail, 5 runtime_error,
2 illegal_cast.
`built-ins/SuppressedError`: **6 / 22 pass (27.3%)** — 10 type_error, 4 assertion_fail, 2 illegal_cast.

Spec §20.5.7 (AggregateError) requires:
1. Constructor `AggregateError(errors, message, options)` calls `IteratorToList(errors)` — must
   accept any iterable (Array, Set, custom iterator).
2. `errors` property: a frozen Array of the iterated errors.
3. `cause` is set from `options.cause` if `options` has it (`HasProperty`, not just truthy).
4. `message` is coerced to string only if defined.

Spec §20.5.10 (SuppressedError) requires similar: `SuppressedError(error, suppressed, message, options)`,
all 4 args validated, options.cause handled.

The 9 + 10 type_error counts indicate our constructor throws on inputs it should accept (likely
fails when `errors` is not an Array but is iterable — e.g. Set or generator).

## Acceptance criteria

1. `built-ins/AggregateError/errors-iterabletolist.js` passes.
2. `built-ins/AggregateError/properties-of-error-objects.js` passes.
3. `built-ins/SuppressedError/constructor-properties.js` passes.
4. Pass-rate for `built-ins/AggregateError` rises from 16% to ≥70%; SuppressedError from 27% to ≥70%.

## Files to modify

- `src/runtime.ts` — `__construct_aggregate_error`, `__construct_suppressed_error`
- `src/codegen/registry/errors.ts` (or wherever Error constructors are registered)

## Implementation Plan

### Root cause

The AggregateError constructor wrapper currently calls `Array.isArray(errors)` and throws TypeError
otherwise. Spec actually requires `IteratorToList(GetIterator(errors))` — must accept Set, Map,
generators, custom iterables.

### Approach

```javascript
// __construct_aggregate_error pseudo-code
function constructAggregateError(errors, message, options) {
  // §20.5.7.2 step 4: errorsList = IteratorToList(GetIterator(errors))
  if (errors == null) throw TypeError("errors must be iterable");
  const errorsList = Array.from(errors); // host-import path
  // §20.5.7.2 step 5: O = OrdinaryCreateFromConstructor(...)
  // step 6: install errors as a frozen array
  // step 7: install message if defined
  // step 8: InstallErrorCause(O, options) — only if options.cause exists
  ...
}
```

Mirror for SuppressedError.

### Edge cases

- `errors` argument is null/undefined → TypeError ("not iterable").
- options is non-object → silent skip (not an error).
- options.cause is `undefined` but the property exists → still install (spec uses HasProperty).

### Test262 sample

- `test262/test/built-ins/AggregateError/errors-iterabletolist.js`
- `test262/test/built-ins/SuppressedError/cause.js`

## Findings & resolution (2026-05-27)

### What was actually broken (root cause)

1. **`new AggregateError([1,2,3])` trapped at runtime.** The `errors` arg arrives
   as an opaque WasmGC vec struct — neither `Array.isArray` nor JS-iterable. The
   old code's fallback `throw new TypeError(String(errors) + ...)` itself trapped
   with *"Cannot convert object to primitive value"* (ToPrimitive on the opaque
   struct). Now: when `errors` has no JS `Symbol.iterator` AND is a genuine vec
   (no named struct fields, via `_getStructFieldNames`), materialize it through
   `__vec_len`/`__vec_get` (same machinery `__array_from` uses). `Set` / arrays /
   generators iterate correctly.
2. **`SuppressedError` had no dedicated constructor** — it went through the generic
   3-param extern-class path which dropped the 4th `options` arg (no `cause`) and
   mishandled message coercion. Added `__new_SuppressedError(error, suppressed,
   message, options)` host import + new-super.ts/calls.ts codegen, mirroring
   `__new_AggregateError`.
3. **`cause` from `options` (HasProperty, incl. `cause: undefined`)** is now
   installed for both via the shared `_installErrorCause` helper. The engine's
   native `InstallErrorCause` can't read an opaque WasmGC options struct, so we
   read the field ourselves (raw, no recursive struct→plain conversion that would
   break `error.cause === cause` reference identity).

### Verified (tests/issue-1634.test.ts, 10/10 pass)
Array-literal errors, Set errors, `Array.isArray(errors)`, cause object-identity,
no-cause-when-options-omitted, cause-when-`cause:undefined` (HasProperty),
`AggregateError(undefined)` throws TypeError, SuppressedError error/suppressed
reference identity, message coercion, no-cause-when-options-omitted.

### test262 conformance: NET ZERO in the two target dirs (no regression)
`built-ins/AggregateError` 6/25 and `built-ins/SuppressedError` 7/22 — **same as
current main** (baseline measured 6/25 + 7/22, not the stale 4/25 + 6/22 in the
problem statement). The ≥70% acceptance target is **not reachable from this
issue's scope**: the dominant remaining failures are out-of-scope infrastructure
gaps, not the iterable/cause behavior this issue targets:
- `TypeError: Cannot access property on null or undefined` — `AggregateError.prototype`
  / `Object.getPrototypeOf(...)` returns null on extern classes (prototype-object
  access gap). Affects ~9 prototype/* tests in each dir.
- `is-a-constructor.js` / `length.js` — `Reflect.construct` brand + `fn.length`
  introspection on extern-class constructors.
- `message-method-prop-cast.js` / `order-of-args-evaluation.js` — ToPrimitive on a
  Symbol/object `message` (Symbol→string coercion, see #1658).
- `proto-from-ctor-realm.js` — needs `$262` realm helper (always skipped).
- The remaining `errors-iterabletolist.js` failure is a **custom JS iterator
  protocol over a WasmGC-struct object literal** (`{ [Symbol.iterator]() {...} }`)
  — the shared iterator-bridge gap (#1320 / #1620 / #1633), where the struct's
  sidecar-stored `@@iterator` method is not invokable through the host boundary.

These improvements are runtime-correctness wins (programs constructing these
errors with real iterables / cause now behave per spec) even though the test262
*harness* files still fail on the unrelated introspection asserts above.
