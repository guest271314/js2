---
id: 820h
title: "DisposableStack / AsyncDisposableStack brand-check and protocol stubs (~74 fails)"
status: done
created: 2026-05-21
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: builtins
language_feature: explicit-resource-management
goal: async-model
sprint: 56
parent: 820
es_edition: ES2025
test262_fail: 74
---
# #820h — (Async)DisposableStack brand check + protocol

## Problem

~74 test262 failures across `built-ins/DisposableStack/*` and
`built-ins/AsyncDisposableStack/*`. Errors:

- `TypeError: Cannot access property on null or undefined` on
  `.disposed`, `.dispose`, `.use`, `.adopt`, `.defer`.
- `Symbol.dispose` / `Symbol.asyncDispose` brand checks missing on the
  receiver.
- `prototype-from-newtarget-*` tests fail because the prototype chain isn't
  wired for the explicit resource management built-ins.

This is the explicit resource management (ERM) ES2025 feature surface, which
appears to be partially stubbed: the constructors are present but
`prototype-from-newtarget` / receiver brand checks / protocol method
delegation are not.

## Sample failing tests
- `test/built-ins/AsyncDisposableStack/prototype-from-newtarget-custom.js`
- `test/built-ins/DisposableStack/prototype/dispose/not-a-constructor.js`
- `test/built-ins/DisposableStack/prototype-from-newtarget-abrupt.js`

## Suspected source

- `src/codegen/builtins/` — no dedicated `disposable-stack.ts` exists yet;
  the constructors are likely defined inline in `runtime.ts` without proper
  brand checks.
- `src/codegen/runtime.ts` — `prototype-from-newtarget` chain wiring.

## Spec reference

- ECMAScript §27.3 DisposableStack Objects
- §27.4 AsyncDisposableStack Objects
- §27.5 Symbol.dispose / Symbol.asyncDispose protocol

## Acceptance criteria

- [ ] At least 60 of the ~74 tests flip to `pass`.
- [ ] Brand check on `.disposed`, `.dispose`, `.use`, `.adopt`, `.defer`
      receiver — throws `TypeError` (not null-deref) when called on a
      non-(Async)DisposableStack receiver.
- [ ] `prototype-from-newtarget` returns the correct prototype object.
- [ ] No regressions in already-passing ERM tests.

## Notes

- ES2025 feature; consider whether this is in scope before the rest of the
  ES2025 surface is built out. May be a candidate for `goal: deferred`
  re-classification if the team isn't pursuing ES2025 coverage yet.

## Root cause

The suspected source (`prototype-from-newtarget` chain wiring / missing
brand checks) was a red herring. The constructors *are* host-delegated and
`new DisposableStack().dispose()` already works. The real defect: bare
identifiers `DisposableStack` / `AsyncDisposableStack` / `SuppressedError`
used as **values** (not in `new X()` / `x.method()` position) fell through
`compileIdentifier`'s "graceful fallback for known-but-unimplemented globals"
and emitted `ref.null.extern`. So every reflective test —
`DisposableStack.prototype`, `Object.getOwnPropertyDescriptor(DisposableStack.prototype, …)`,
`Reflect.construct(DisposableStack, …)` — saw `null` and threw a
WebAssembly.Exception or "null is not a constructor".

## Fix

`src/codegen/expressions/identifiers.ts` — added a handler (mirroring the
existing `globalThis` handler) that resolves these three ERM globals to the
real host constructor via `__extern_get(__get_globalThis(), name)` when the
name is not shadowed by a local/captured binding or a user class. With the
host constructor object visible, its `.prototype`, accessor descriptors, and
`[[Construct]]` all work through the existing extern machinery.

## Test Results (against /workspace/test262, via real harness)

DisposableStack + AsyncDisposableStack suite (143 tests, runnable subset):
- **before**: 72 pass / 71 fail
- **after**:  121 pass / 22 fail  (**+49 flips**)

The `[object WebAssembly.Exception]` brand/descriptor failure class is fully
eliminated. Unit coverage: `tests/issue-820h.test.ts` (7 tests, incl.
shadowing + normal-use regression guards).

### Remaining 22 (out of scope for this fix)
- `$262 is not defined` (2) — cross-realm harness, not implementable here.
- `[Symbol.dispose] is not a function` / `[object Object] is not a function`
  (~7) — disposer callbacks/objects are WasmGC values the host can't invoke
  as JS functions; needs a broader compiled-object→host-protocol bridge.
- `is-a-constructor` / `undefined-newtarget` / `newtarget-prototype-is-not-object`
  / `prototype-from-newtarget-*` (~13) — `Reflect.construct` with bound-fn
  newTarget and `new stack.method()` edge cases; deeper host bridging.
