---
id: 1438
sprint: 52
title: "spec gap: Map, WeakMap, and WeakSet residual collection semantics"
status: review
created: 2026-05-11
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: keyed-collections
goal: spec-completeness
related: [837, 859, 1103, 1351]
---
# #1438 - Map, WeakMap, and WeakSet residual collection semantics

## Problem

Spec §24.1, §24.3, and §24.4 have no focused open tracker in the compliance
summary despite residual failures:

- Map: `177 / 215` passing, 38 failures.
- WeakMap: `110 / 141` passing, 31 failures.
- WeakSet: `76 / 85` passing, 9 failures.

Existing issues covered broad Wasm-native collection representation and older
Map `forEach` problems, but the report still needs a current issue for the
remaining spec gaps.

## Acceptance criteria

1. Map `forEach` callback `thisArg`, mutation-during-iteration, and callback
   error propagation match test262.
2. WeakMap/WeakSet reject invalid keys with the required TypeError behavior.
3. WeakMap/WeakSet constructor iterable handling closes iterators on abrupt
   completion.
4. Proposal-only methods are either implemented or intentionally filtered with a
   report-visible reason.
5. §24.1, §24.3, and §24.4 pass-rates improve and all remaining residuals point
   to narrower follow-ups.

## Files to inspect

- `src/codegen/builtins.ts`
- `src/runtime.ts`
- `tests/issue-1438.test.ts`

## Implementation notes (2026-05-20)

Four runtime-side bugs were responsible for the bulk of the residual
failures in Map/WeakMap/WeakSet:

1. **`__make_iterable` threw on opaque wasmGC structs**: the
   `obj[Symbol.iterator]` probe at the top of `convertToJS` threw
   "WebAssembly objects are opaque" on any wasm struct, so the recursive
   conversion silently returned the original opaque value. Rewrote the
   probe to check `_isWasmStruct` first; plain JS objects (including
   non-iterable ones used as WeakMap keys) pass through unchanged.
2. **`new Map(iter)` / `new WeakMap(iter)` did not materialise the
   iterable when the codegen path skipped `__make_iterable`**: the
   `extern_class "new"` handler now eagerly converts the first arg via a
   new `_convertIterableForHost` helper for the keyed-collection
   constructors. Inner tuple structs (`[k, v]`) are converted to real JS
   arrays so the native engine sees `[symbol|object, value]` pairs.
3. **`Map.prototype.forEach` callback was a wasm closure struct**: V8
   threw "object is not a function". Added a dedicated `forEach`
   branch in the `extern_class` method dispatcher that wraps wasm
   closures via `_wrapWasmClosure(cb, 3, …)` and forwards `thisArg`
   explicitly.
4. **`getOrInsertComputed` polyfill rejected wasm-closure callbacks**:
   the polyfill's `typeof callback !== "function"` check fired for
   wasm closures and threw `"callbackfn is not callable"`. Wrap
   wasm-struct callbacks with `_wrapWasmClosure(cb, 1, …)` before the
   callability check. The same code path now also accepts `symbol`
   keys on `WeakMap` (per ES2023 symbols-as-weakmap-keys).

### Out of scope

- Symbols-as-WeakMap-keys end-to-end: our compiler models `Symbol(…)`
  as an i32 counter, so passing a "symbol" to native `WeakMap.set`
  produces a number rather than a real JS Symbol. Tracked separately;
  the residual category narrows to "compiler needs a Symbol box".
- Iterator-close on abrupt completion for user-defined iterables with
  custom `next` / `return` methods. The current host bridge eagerly
  materialises the iterable, so `return()` is never invoked. Fixing
  this requires a lazy bridge (JS generator wrapper) and is best done
  alongside the broader iterator-protocol work.

## Test Results (2026-05-20, local)

`npm test -- tests/issue-1438.test.ts` — 9/9 passing. The probe covers:

- `new Map(iterable)` with 3 entries (size === 3).
- `new WeakMap(iterable)` with object keys, both `get`-able after
  construction.
- `Map.prototype.forEach` with a plain arrow callback (sum) and a
  no-arg closure (count).
- `WeakMap.prototype.set` returning `this` for chaining.
- `Map.prototype.getOrInsertComputed` evaluating the callback on
  missing keys and skipping it on present keys.
- `WeakMap.prototype.delete` returning `true` for a key inserted via
  the constructor iterable.

`npm test -- tests/equivalence/weakmap-weakset.test.ts tests/equivalence/ir-slice10-map-set.test.ts tests/equivalence/map-set-basic.test.ts tests/iterators.test.ts`
— 36/36 passing (no regressions in adjacent suites).
