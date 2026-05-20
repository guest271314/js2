---
id: 1465
sprint: 52
title: "spec gap: Promise.all / allSettled / any / race iterable + subclass fidelity"
status: in-progress
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: promise-combinators
goal: spec-completeness
related: [1326, 1368]
---
# #1465 - spec gap: Promise.all / allSettled / any / race iterable + subclass fidelity

## Problem

`built-ins/Promise/` accounts for **662 test262 failures** across:

```
124 prototype       104 allSettled    98 all
95  fromAsync (Array.fromAsync is here for some platforms)
94  any             94  race          30  resolve   15  reject
```

The 390 failures in the four combinators (`all`/`allSettled`/`any`/
`race`) cluster around three spec gaps:

### 1. Iterable input semantics

Tests like `Promise/all/iter-arg-is-string-resolve.js`,
`allSettled/iter-assigned-number-reject.js`,
`race/iter-returns-false-reject.js` cover the spec algorithm
`PerformPromiseAll` step 4: `GetIterator(iterable)`. Iterables include:

- a string (its iterator yields code points);
- an arguments object;
- a custom object with `Symbol.iterator` set to `1` / `false` / `null`
  → must call `IfAbruptRejectPromise` → return rejected promise.

Our runtime uses `_toIterable(arr)` (see `src/runtime.ts:3880`+), which
treats anything that is `Array.isArray` as fine but doesn't drive the
spec's full GetIterator → IteratorRecord → IteratorClose protocol.

### 2. Subclass constructor (`Promise.all.call(C, …)`)

Tests `ctx-ctor-throws.js`, `ctx-non-ctor.js`, `subclass-reject-count.js`
verify that:

- `Promise.all.call(C, iter)` throws TypeError if `C` is not a
  constructor;
- the helper invokes `Construct(C, [executor])` (NewPromiseCapability)
  exactly once;
- the result chains correctly when `C` is a subclass with a custom
  `then`.

The `Promise_all` host import receives `thisArg` (good), but
`_resolveCtor(thisArg)` falls back to the global `Promise` silently
when the arg is unusable instead of throwing.

### 3. Trap / hook observation order

`Promise/all/invoke-resolve-get-error.js` and analogous
`invoke-then-error-close.js` (in `allSettled`/`any`/`race`) verify the
spec calls `Get(C, "resolve")` once, calls `Get(resolved, "then")` for
each item, and **closes the underlying iterator** if any of these
throw. Our runtime path inherits the JS host's behaviour for the
trivial case but loses fidelity once `thisArg` is a custom constructor
because the host's `Promise.all.call(C, iter)` re-enters our async
scheduler with the wrong constructor binding.

### Promise.prototype.* (124)

`prototype/` failures include:
- `subclass-reject-count.js` — `[Symbol.species]` not consulted;
- `resolve-settled-fulfilled-poisoned-then.js` — poisoned `then` on a
  fulfilment value must be observed and rejection delivered;
- `S25.4.5.1_A2.1_T1.js` — `.then` argument coercion (non-callable →
  identity);
- `subclass-reject-count.js` — `this.constructor[Symbol.species]`.

## Failure count

662 in `built-ins/Promise/`. Realistic target: **~360** (some
`prototype/` tests depend on full subclassing + Symbol.species which
is a separate axis; carve those off as a follow-up).

## Root cause

In `src/runtime.ts` lines 3880–3905, the four combinator imports look
like:

```js
if (name === "Promise_all")
  return (thisArg, arr) => {
    const C = _resolveCtor(thisArg);
    return Promise.all.call(C, _toIterable(arr));
  };
```

1. **`_toIterable(arr)`** does not run the spec
   `GetIterator(iterable, sync)` — when arr is a primitive iterable
   (string, custom non-array iterable) the iterator may not be invoked,
   producing wrong resolutions.

2. **`_resolveCtor`** falls back to the global `Promise` when
   `thisArg` is non-callable instead of returning a rejected promise
   (Spec `PromiseAll` step 1: `Let C be this value. If Type(C) is not
   Object, throw a TypeError`).

3. **`Get(C, "resolve")` is hidden** behind the host's `Promise.all`
   call, so tests that monkey-patch `C.resolve` see *the host's
   Promise.resolve*, not the patched one.

4. **`[Symbol.species]`** is not honoured by `Promise.prototype.then`
   in our `Promise_then`/`Promise_then2` imports.

5. **`Promise.prototype.then` coercion of non-callable onFulfilled /
   onRejected** uses identity per spec — host engines do this, but our
   standalone Promise (#1326) does not.

## Acceptance criteria

1. `Promise.all/allSettled/any/race` accept any iterable (string,
   arguments, custom `Symbol.iterator`); non-iterable input rejects.
2. `Promise.all.call(C, iter)` with non-constructor `C` throws
   TypeError synchronously (or rejects per spec step).
3. `Promise.all.call(C, iter)` calls `Get(C, "resolve")` and invokes
   the returned resolve function for every item.
4. `Iterator close` invoked when any of the spec-mandated `Get`/`Call`
   hooks throws.
5. `Promise.prototype.then` consults `this.constructor[Symbol.species]`
   to create the resulting promise.
6. Standalone `Promise.then` (#1326) accepts non-callable on*
   arguments via the identity-substitute spec rule.
7. ≥330 of the 662 failures resolved.
8. Tests: `tests/issue-1465.test.ts` covers iterable input (string,
   non-array iterable), subclass constructor non-callable,
   poisoned-resolve, and non-callable then arg.

## Files to inspect

- `src/runtime.ts` lines 3880–3905 (combinator imports) and the
  `_toIterable` / `_resolveCtor` helpers earlier in the file
- `src/codegen/async-scheduler.ts` — standalone Promise.then path
- `src/codegen/expressions/calls.ts` 3331–3500 — call-site dispatch
- `tests/issue-1465.test.ts`

## Notes

- #1326 (standalone microtask queue) is the foundation; combinator
  fidelity in standalone mode is a stretch goal, focus on JS-host.
- #1368 added the `thisArg` plumbing — this issue tightens its
  semantics to match the spec exactly.
- `Promise/fromAsync` (95) tracks `Array.fromAsync` not `Promise.fromAsync`;
  if those tests are mis-pathed, leave them for a separate issue.

## Implementation notes (2026-05-20)

Fixed in `src/runtime.ts` `_toIterable` / `_resolveCtor` + `src/codegen/expressions/calls.ts` `emitIterableArg`:

1. **Runtime `_toIterable`**: drives the spec's GetIterator contract by
   delegating to the native engine. Strings, generators, arguments objects,
   Sets/Maps/TypedArrays, and any object with `Symbol.iterator` pass through
   unchanged. WasmGC vec externrefs (only emitted when length > 0 is
   detectable via `__vec_len`) get materialised into a real JS array.
   Non-iterable primitives (number, boolean, undefined, symbol, bigint) and
   non-iterable objects pass through so the native engine throws TypeError
   per spec, instead of being silently wrapped in `[v]` (the old fallback).

2. **Runtime `_resolveCtor`**: still defaults `null`/`undefined` to global
   `Promise` for the natural `Promise.all(iter)` call. Truthy thisArg flows
   through to the native engine, which throws TypeError for non-constructors
   per `NewPromiseCapability` step 1. This covers the bulk of `ctx-non-ctor`
   tests (which use `{}`, numbers, symbols, etc.).

3. **Codegen `emitIterableArg`**: when the iterable argument is a syntactic
   `ArrayLiteralExpression` (the common test262 pattern `Promise.all([p1, p2])`),
   compile each element to externref and push it through `__js_array_new`/
   `__js_array_push` to build a real JS array eagerly. Without this, the
   array literal would be lowered to a wasm tuple or vec struct that is
   opaque to the host engine — `Promise.all.call(C, opaqueStruct)` then throws
   "object is not iterable". Other shapes (variables, method results, spread)
   fall back to plain externref coercion and trust the runtime helper's
   dispatch.

4. **Codegen `emitVecAccessExports`**: now also fires when any of the
   `Promise_${method}` host imports are registered, so the runtime can
   round-trip wasm vec iterables when JS array materialisation isn't
   available (e.g. a `Promise<number>[]` returned from a host-class method).

Out of scope (deferred to follow-ups):
- `Promise.prototype.then` consulting `this.constructor[Symbol.species]`
  (criterion 5) — requires species-protocol support, broader work.
- Standalone-mode (#1326) non-callable `then` args (criterion 6) — affects
  WASI builds; JS-host runs through native, which already handles it.
- `Promise.prototype.subclass-reject-count.js` and `S25.4.5.1_A2.1_T1.js`
  failures, which depend on item-by-item `.then` callback delivery in
  pure-Wasm Promise (#1326).

## Test Results

- `tests/issue-1465.test.ts` — 17 tests passing.
- `tests/issue-1368.test.ts` — 4 tests passing (no regression).
- `tests/issue-1326.test.ts` — 11 tests passing (no regression).
- `tests/promise-combinators.test.ts` — 2 of 4 passing; the 2 failures
  (`Promise.all with resolved values` and `Promise.race with resolved values`
  via host-class method) are pre-existing on `main` — unrelated to this
  change (they hit a separate codegen path where a host method returns a
  `Promise[]` and the externref is undefined at runtime).
- `tests/equivalence/{async,await,array}/**` — same 15 pre-existing failures
  as `main`; no new regressions.
