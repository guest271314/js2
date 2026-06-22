---
id: 2614
title: "Promise.{all,allSettled,any,race}: read constructor's own `resolve` + callable resolve/reject element functions (~45 fails)"
status: ready
created: 2026-06-22
updated: 2026-06-22
priority: medium
feasibility: medium
task_type: bug
area: async, codegen, promise
language_feature: promise
goal: async-model
sprint: 65
parent: 1042
related: [1528, 1368, 1116, 1694]
note: "Re-measured 2026-06-22 (arch, ASYNC lane). Largest single combinator bucket NOT owned by #1528 (which owns the non-constructor TypeError sub-bucket). Distinct root cause: the combinator must Get(constructor,'resolve') and the per-element resolve/reject functions must be observable callable functions."
---
# #2614 — Promise combinators: invoke the constructor's own `resolve` + expose callable resolve/reject element functions

## Re-measured context (2026-06-22, ASYNC lane)

`test/built-ins/Promise/{all,allSettled,any,race}` has **125 fails** on
current main even though #1368, #1116, #1694 all landed. The breakdown:

| Sub-bucket | n | Owner |
|---|---|---|
| `promise_error: Promise resolve or reject function is not callable` | 45 | **this issue** |
| `illegal_cast in Constructor()/__fn_tramp_Constructor_*` (subclass/species capability) | ~19 | this issue (secondary) or follow-up |
| `[object Object] is not a constructor` (non-constructor TypeError) | ~8 | **#1528** (already ready, sprint 65) |
| `Function.prototype.bind called on non-callable` | ~5 | this issue (same element-fn root) |
| assorted `arguments.length` / `callCount` assertions | ~rest | downstream of the above |

This issue scopes the **45-fail `not callable` bucket + its `bind`/element-fn
siblings** — the largest combinator bucket not owned by #1528.

## Problem

Two related spec-conformance gaps in the combinator lowering:

1. **The combinator must read `resolve` off the constructor** (spec
   `PerformPromiseAll/Any/Race` step: `Let promiseResolve be ? Get(constructor,
   "resolve"); If IsCallable(promiseResolve) is false, throw TypeError`). Tests
   monkey-patch `Promise.resolve` and assert the combinator calls *that*
   function once per iterated value, with `this === Promise` and a single arg
   (`all/invoke-resolve.js`, `any/invoke-resolve-on-promises-*.js`,
   `race/invoke-resolve.js`). Our combinator path uses an internal resolve and
   never invokes the constructor's observable `resolve`, so the patched
   function's `callCount` stays 0 and the `not callable` guard or the
   assertion fails.

2. **The per-element resolve/reject functions must be real callable JS
   functions** (spec `CreateResolvingFunctions` / the all-resolve-element /
   allSettled-resolve-element / reject-element closures). Tests call
   `.bind`, read `.length`, and invoke these element functions directly
   (`allSettled/call-resolve-element.js`,
   `allSettled/reject-element-function-length.js`,
   `any/invoke-resolve-on-values-every-iteration-of-custom.js` →
   `Function.prototype.bind called on non-callable`). Our lowering produces a
   non-callable internal value for the element function.

## Failing test examples (re-measured)

- `test/built-ins/Promise/all/invoke-resolve.js`
- `test/built-ins/Promise/any/invoke-resolve-on-promises-every-iteration-of-promise.js`
- `test/built-ins/Promise/race/invoke-resolve.js`
- `test/built-ins/Promise/allSettled/call-resolve-element.js`
- `test/built-ins/Promise/any/invoke-resolve-on-values-every-iteration-of-custom.js`
- `test/built-ins/Promise/{all,allSettled,any}/species-get-error.js`

## Implementation Plan

### Root cause
The combinator codegen/runtime path short-circuits the spec's observable
operations: it does not `Get(constructor, "resolve")` and invoke it per
element, and the resolve/reject element functions it creates are not
first-class callable functions (no `__make_callback`-style host wrapper /
no `.length`/`.bind`-able shape).

### Where the combinators live
- `grep` for the combinator dispatch: `Promise.all` / `Promise.allSettled` /
  `Promise.any` / `Promise.race` handling in `src/codegen/expressions/calls.ts`
  (the `.then`/Promise static-method dispatch region near the
  `calls.ts:3807` instance-method block) and the host runtime
  implementations in `src/runtime.ts` (search `Promise_all`,
  `Promise_allSettled`, `Promise_any`, `Promise_race`).
- Determine whether each combinator is (a) lowered to a host import call, or
  (b) compiled-away. The `not callable` host string suggests the **host
  runtime** implementations of these combinators are the locus.

### Changes (JS-host first; standalone deferred)

**File: `src/runtime.ts`** (the combinator implementations)
- Rewrite each combinator to follow the spec algorithm using the **passed-in
  constructor** `C` (the `this` of `Promise.all` etc.):
  1. `let promiseResolve = C.resolve` (a property GET, so a monkey-patched
     `Promise.resolve` is observed). `if (typeof promiseResolve !== "function")
     throw TypeError("Promise resolve or reject function is not callable")`.
  2. For each iterated value: `nextPromise = promiseResolve.call(C, nextValue)`
     — invoked with `this === C` and exactly one argument (satisfies the
     `invoke-resolve` assertions).
  3. Build the per-element resolve function as a **real closure** (a JS
     function with the spec `length` of 1 and `.bind`-able) — not an internal
     marker. For `all`/`allSettled`/`any` the element functions carry the
     `[[AlreadyCalled]]` / index / values / capability slots.
  4. Settle the combined capability via the same resolving functions the
     executor would use.
- Keep the host implementations behind the existing JS-host gate; standalone
  combinator conformance to this depth stays deferred (the standalone
  `$Promise` combinator path is a separate, larger effort — file forward).

**File: `src/codegen/expressions/calls.ts`** (only if the combinator is
compiled-away rather than host-imported)
- If the combinator is currently lowered inline, ensure it threads the actual
  constructor receiver (`Promise` or a subclass) into the runtime call so
  `C.resolve` is read from the right object. Reuse the species/`this`-capability
  plumbing landed by #1694.

### Edge cases
- `Promise.resolve` deleted / non-callable → `TypeError` with the exact spec
  wording the tests assert.
- Subclass receiver (`class P2 extends Promise {}`; `P2.all([...])`) — read
  `resolve` off `P2`. (The `illegal_cast in Constructor()` sub-bucket is the
  subclass-capability path; if it does not fall out of the same rewrite, file
  it forward as a follow-up rather than expanding this slice.)
- `species-get-error.js` — a throwing `Symbol.species`/`resolve` getter must
  propagate; do not swallow.

### Test files to verify (must flip pass)
- `test/built-ins/Promise/all/invoke-resolve.js`
- `test/built-ins/Promise/race/invoke-resolve.js`
- `test/built-ins/Promise/allSettled/call-resolve-element.js`
- `test/built-ins/Promise/any/invoke-resolve-on-promises-every-iteration-of-promise.js`

### Regression watch
- The 487 Promise tests that currently pass must stay green — the rewrite
  must preserve the happy-path resolution order.
- Coordinate with **#1528** (non-constructor TypeError sub-bucket): both touch
  the combinator path. Land order: whichever lands first, the second rebases;
  create a `[CONFLICT]` TaskList item if both edit the same `runtime.ts`
  combinator block.

### Estimate / honesty
This is the **most involved of the three ASYNC-lane slices** — it is
combinator-internals work, not a one-line detector fix. Scope to the
`not callable` + `bind`/element-fn bucket (~45 + ~5). The
`illegal_cast`/subclass-capability sub-bucket (~19) may or may not fall out;
if not, file forward. Estimate ~120 LoC `runtime.ts` + ~30 LoC codegen +
~60 LoC tests. **~45-50 test262 pass** if the subclass path comes along, ~45
otherwise. Suitable for a **senior-dev**.
