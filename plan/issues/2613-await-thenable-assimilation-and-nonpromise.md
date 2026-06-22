---
id: 2613
title: "await on a thenable/non-Promise: assimilate via host (PromiseResolve) instead of returning the raw object (~15 fails)"
status: ready
created: 2026-06-22
updated: 2026-06-22
priority: high
feasibility: medium
task_type: bug
area: async, codegen
language_feature: async
goal: async-model
sprint: 65
parent: 1042
note: "Re-measured 2026-06-22 (arch, ASYNC lane). The ONLY residual bucket that genuinely needs await to settle a thenable. Solvable in JS-host mode via host PromiseResolve assimilation WITHOUT flipping the CPS gate — does not need the #1373b epic."
---
# #2613 — `await <thenable>` / `await <non-Promise>` must assimilate, not pass the object through

## Re-measured context (2026-06-22, ASYNC lane)

Of the async cluster's residual, this is the **one bucket that genuinely
exercises await suspension semantics**. The legacy `AwaitExpression` no-op
(`expressions.ts:1165`) passes the operand straight through:
`await x === x`. That happens to give the right answer when `x` is already the
resolved value (the common case the legacy fakery is built for), but is wrong
when `x` is:

1. a **user thenable** (`{ then(res, rej) { res(42); } }`) — `await thenable`
   must run `then` and resolve to `42`, but legacy returns the object.
2. a **non-Promise primitive** (`await 1`) where the test observes the
   `PromiseResolve` wrapping / one-microtask-tick ordering.
3. a **monkey-patched / subclassed Promise** whose `then` / constructor is
   observed during await.

This bucket does NOT require the full CPS state machine — in **JS-host mode**
the host already has a real microtask queue and `Promise.resolve`. The fix is
to route the awaited operand through host `Promise.resolve` (ECMAScript
§27.7.5.3 Await step 2: `PromiseResolve(%Promise%, value)`) and unwrap its
settled value, rather than passing the operand through untouched.

## Failing tests (re-measured from baseline JSONL, 2026-06-22)

`test/language/expressions/await/`:
- `await-awaits-thenables.js` (assertion_fail)
- `await-awaits-thenables-that-throw.js` (assertion_fail)
- `await-throws-rejections.js` (assertion_fail)
- `await-non-promise-thenable.js` (null_deref)
- `await-non-promise.js` (wasm_compile — `await` on a bare numeric/primitive
  produces invalid Wasm in the legacy path; the assimilation wrap also fixes
  the type)
- `await-monkey-patched-promise.js` (null_deref)
- `async-await-interleaved.js`, `for-await-of-interleaved.js` (null_deref —
  ordering-sensitive)

`test/language/module-code/top-level-await/`:
- `await-awaits-thenables.js`, `await-awaits-thenables-that-throw.js`

`test/built-ins/Array/fromAsync/` (same root — `await`s each element's
thenable once):
- `sync-iterable-with-thenable-{,async-mapped-,sync-mapped-}awaits-once.js`
- `non-iterable-with-thenable-{,async-mapped-,sync-mapped-}awaits-once.js`
- `non-iterable-input-with-thenable-async-mapped-awaits-callback-result-once.js`

≈ **15 tests** (8 in `await/`, 2 top-level-await, ~5 fromAsync).

## Implementation Plan

### Root cause
`AwaitExpression` lowers as identity. For a thenable / non-Promise operand the
identity passthrough returns the wrong object/value (or invalid Wasm for a
bare primitive). Per §27.7.5.3 Await, the operand must be run through
`PromiseResolve` and the await must yield the *settled* value.

### Strategy — JS-host assimilation (no CPS gate flip)
This is the key scoping decision. The legacy synchronous-async model already
relies on the JS host resolving Promises synchronously-enough that the awaited
value is available. We extend that: when the await operand's static type is
**not** a definite already-resolved primitive — i.e. it is a thenable, an
`any`/`object`, or `Promise<T>` whose `then` may be user-defined — route it
through a host import that performs `PromiseResolve` + synchronous-settled
unwrap (the host runs the microtask drain that the test's `.then`/`asyncTest`
harness expects). This stays entirely in JS-host mode; standalone/WASI await
of an arbitrary thenable remains deferred to the CPS epic (#1373b Slice
2/3 — see #1042). Mark the standalone path with a clear `reportError` +
legacy fallback so we don't emit half-formed Wasm.

### Changes

**File: `src/codegen/expressions.ts`**
- Function `compileExpressionInner`, `ts.isAwaitExpression(expr)` arm (line
  1165). Today: `return compileExpressionInner(ctx, fctx, expr.expression)`.
  - Compile the operand to externref.
  - If the operand's static type is a bare resolved primitive already in the
    raw-value fast path (number/string/boolean literal expression) AND not a
    thenable, keep the current passthrough (no regression on the hot path).
  - Otherwise emit `call $__await_thenable(operand)` — a new host import
    `(externref) -> externref` that does `await Promise.resolve(value)`-
    equivalent assimilation and returns the settled value (host drains its
    own microtask queue). Rejections surface as a thrown wasm exception via
    the existing `__get_caught_exception` machinery so a surrounding
    `try/catch` (the `await-throws-rejections` / `that-throw` tests) catches
    them. Declare via `ensureLateImport` (pattern at `expressions.ts:317`).
- Guard: only take the assimilation path when `!isStandalonePromiseActive(ctx)`
  (JS-host). In standalone mode, keep the legacy passthrough for already-
  resolved values and `reportError("standalone await of arbitrary thenable
  pending #1373b CPS")` only for the genuinely-thenable case.

**File: `src/runtime.ts`**
- Add the `__await_thenable` host handler near the other Promise primitives
  (search `Promise_resolve`, ~`runtime.ts:7835`). Because the wasm side is
  synchronous, the handler must return the settled value synchronously; use
  the existing test-runner microtask-snapshot pattern (the runner already
  flushes microtasks between top-level statements for the legacy async model —
  reuse `_maybeWrapCallable` / the existing settle helpers). If a truly async
  (I/O-pending) thenable is awaited, this returns the pending state and the
  surrounding legacy model already handles the common synchronous-thenable
  case the tests cover. **Validate against `await-awaits-thenables.js` first.**

### Wasm IR pattern
```wasm
;; await <operand>  (JS-host, possibly-thenable)
<operand>                       ;; → externref
call $__await_thenable          ;; → externref settled value (or throws on reject)
```

### Edge cases
- `await <primitive>` (e.g. `await 1`) → `__await_thenable(box(1))` returns
  the boxed value; fixes the `await-non-promise.js` wasm_compile (the operand
  is uniformly externref now, no type mismatch).
- `await <rejected thenable>` → host re-throws; the existing
  `wrapAsyncCallInTryCatch` / try-catch lowering catches it. Verify
  `await-throws-rejections.js` + `await-awaits-thenables-that-throw.js`.
- Nested `await` inside the operand — already handled by recursive compile.
- `await` in async generator / nested function (`await-in-nested-generator.js`,
  `await-in-nested-function.js`) currently fail with `illegal_cast` — that is a
  **different** bug (await inside a non-async-fn context / generator state) and
  is OUT of scope here; file forward if not covered by #1344.

### Test files to verify (must flip pass)
- `test/language/expressions/await/await-awaits-thenables.js`
- `test/language/expressions/await/await-throws-rejections.js`
- `test/language/expressions/await/await-non-promise.js`
- `test/built-ins/Array/fromAsync/sync-iterable-with-thenable-awaits-once.js`

### Regression watch
- `tests/equivalence/async-function.test.ts` / `promise-chains.test.ts` —
  the existing already-resolved-value await tests must stay green (the fast
  path for bare resolved primitives must be preserved).
- `test/language/expressions/await/` overall must not regress the 10 that pass.

### Estimate
~50 LoC codegen + ~30 LoC `runtime.ts` + ~40 LoC tests. **~15 test262 pass**
(JS-host). Standalone thenable-await stays deferred to #1373b.
