---
id: 821
title: "BindingElement null guard over-triggering"
status: done
created: 2026-03-27
updated: 2026-05-27
completed: 2026-05-27
priority: critical
feasibility: medium
reasoning_effort: high
goal: core-semantics
sprint: Backlog
parent: 779
test262_fail: 537
---
# #821 -- BindingElement null guard over-triggering (537 fail)

## Problem

The null guard emitted for destructuring binding elements triggers too aggressively — it throws TypeError on values that are valid but happen to be falsy or have unexpected Wasm types. This causes 537 tests to fail with wrong values or unexpected errors during destructuring.

## ECMAScript spec reference

- [§14.3.3 Runtime Semantics: KeyedBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-keyedbindinginitialization) — step 3: initializer applied when value is undefined, not when null


## Acceptance criteria

- 537 destructuring-related assertion failures fixed
- No regressions in other destructuring tests

## Investigation Notes (2026-03-27)

The 542 null_deref failures in test262 results are NOT caused by the null guard
over-triggering. Investigation showed:

1. The null guard in `emitNullGuard` and `destructureParamObject` works correctly --
   it only fires for `ref_null` types and only when the ref IS actually null at runtime.
2. Default parameter initialization runs BEFORE destructuring, so the null guard
   correctly finds non-null values after defaults are applied.
3. All tested patterns (object/array destructuring, nested destructuring, class methods,
   function params with defaults) work correctly in equivalence tests.
4. The 542 null_deref failures are distributed across: expressions (266), statements (169),
   eval-code (98), arguments-object (5), rest-parameters (2), others (2).
5. 371 of 542 are in `dstr/` test paths -- mostly generated tests using iterator protocol
   (`Symbol.iterator`), async generators, and rest patterns (`[...[...x]]`).
6. The root causes are missing iterator protocol support and complex pattern compilation,
   NOT the null guard mechanism itself.

This issue should be re-scoped or broken into specific sub-issues:
- Iterator protocol for array destructuring (Symbol.iterator support)
- Async generator destructured parameters
- Rest element with nested destructuring

## Resolution (2026-05-27)

The 2026-03-27 note was correct that the null *guard* mechanism is sound. The
real bug in the `init-skipped` family is a **binding-local type-inference**
problem, not a guard problem:

For `{ s: t = counter() }` (or `[w = counter()]`) where `counter()` returns
`void`, TypeScript infers the binding's type as pure `void` — the default
initializer is its only type evidence. `mapTsTypeToWasm` maps `void` → `i32`
(type-mapper.ts:51), so when the property is present and non-`undefined`
(`null`/`0`/`false`/`''`, an externref), the value is coerced into an `i32`
local and destroyed. The default never actually fires (the guard is correct),
but the preserved value is mangled → `assert.sameValue(t, null)` fails.

**Fix**: `resolveBindingElementType` (new, in type-mapper.ts) — when a binding
element has a default initializer AND its resolved type is the void/undefined
sentinel, type the local as `externref` so the real value survives unchanged.
Wired into `ensureBindingLocals` (the central pre-allocation for every
destructuring path: decl, function-param, class-method, catch).

**Measured impact** (init-skipped + init-undef dstr family, 376 tests, via
the test262 runner): main 209 pass → fix 262 pass (**+53**), compile_errors
unchanged (14 → 14). No regressions in the destructuring equivalence suite
(78 pass; the 2 failures in destructuring-extended / destructuring-initializer
pre-date this change).

**Residual sub-issues (NOT fixed here — separate root causes):**
- Eager default-evaluation for `[x = counter()] = [literal]` array params
  nested inside object-literal methods (the param-level default `= [...]`
  interacts with element defaults — ~49 `initCount != 0` fails).
- `init-undef` in `for-await-of` async-generator destructuring (default
  should fire for `undefined` but doesn't — ~27 fails).
- `illegal cast in __closure_*` for some closure-captured dstr defaults (~4).
