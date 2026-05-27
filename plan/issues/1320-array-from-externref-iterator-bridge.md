---
id: 1320
title: "Runtime bridge: Array.from(externref) / Iterator.from(externref) doesn't preserve own [Symbol.iterator] on plain JS objects (4 test262 fails)"
status: in-review
created: 2026-05-07
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: iterators, externref, Array.from
goal: spec-conformance
sprint: 50
related: [1154]
---
# #1320 — Array.from / Iterator.from runtime bridge drops own [Symbol.iterator]

## Background

Filed as a follow-up to #1154 after closing it as resolved. The original
~378 leak-cluster is fixed; 4 tests still hit the
`%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function` error, but the root
cause is **different** — they fail standalone (verified in isolation),
not from prior-test prototype poisoning.

## Failing tests

- `test/built-ins/Array/from/iter-cstm-ctor.js`
- `test/built-ins/Array/from/iter-set-length.js`
- `test/built-ins/Iterator/from/iterable-primitives.js`
- `test/built-ins/Iterator/prototype/flatMap/iterable-primitives-are-not-flattened.js`

The first two fail with the exact V8 native error. The latter two fail
with `WebAssembly.Exception` (likely the same root cause routed through
a different code path).

## Repro

```bash
npx tsx -e "
import { compile } from './src/index.ts';
import { readFileSync } from 'node:fs';
import { buildImports } from './src/runtime.ts';
const src = readFileSync('test262/test/built-ins/Array/from/iter-cstm-ctor.js', 'utf-8');
const r = compile(src, { fileName: 'test.ts', skipSemanticDiagnostics: true });
const imports = buildImports(r.imports, undefined, r.stringPool);
await WebAssembly.instantiate(r.binary, imports);
"
```

Throws synchronously from `WebAssembly.instantiate`:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

The error originates from V8's native `Array.from` inside our runtime's
host-import bridge for the compiled `Array.from(items)` call.

## Hypothesis

The test source pattern is:

```js
var items = {};
items[Symbol.iterator] = function() {
  return { next: function() { return { done: true }; } };
};
result = Array.from.call(C, items);
```

When this compiles, `items` becomes an externref (a JS object reference)
in wasm memory, and the assignment `items[Symbol.iterator] = ...` routes
through our runtime's safeSet for symbol-keyed properties.

Suspected: the safeSet path for `Symbol.iterator` on a plain JS-host
object (externref-wrapped `{}`) either:

1. Routes the assignment to a sibling property (well-known-symbol ID
   path) instead of installing an own `[Symbol.iterator]` descriptor on
   the target object, OR
2. Installs the descriptor on a wrapper that V8's `Array.from` doesn't
   see when walking `items[Symbol.iterator]`.

When the compiled `Array.from(items)` then calls into the host import,
the host invokes native `Array.from(items)`. V8 reads
`items[Symbol.iterator]`, finds either nothing or a non-function value
(inherited from `Object.prototype` after the safeSet path mis-routed),
and throws.

## Investigation start points

- `src/runtime.ts` — locate the `__safeSet` / `_safeSet` host import for
  symbol-keyed property assignment. Compare its handling of
  `Symbol.iterator` on a plain JS object vs. on a wasm-managed struct
  (`_isWasmStruct(obj)` gate referenced in the worker comment at
  test262-worker.mjs L546–554, which describes a similar miss-route
  pattern that #1160 had to defensively clean up).
- `src/codegen/expressions/calls.ts` (or wherever `Array.from` /
  `Iterator.from` is lowered) — verify the call site emits the
  externref directly without re-wrapping.

## Acceptance criteria

1. The 4 listed tests no longer throw the `%Array%.from requires...`
   error in `WebAssembly.instantiate`.
2. `iter-cstm-ctor.js` instantiates and the test body's
   `assert.sameValue(callCount, 1, ...)` passes.
3. No new regressions in tests under
   `test/built-ins/Array/from/` or `test/built-ins/Iterator/`.

## Out of scope

- Prototype-poisoning leak handling (covered by #1154 — closed).
- Any non-`Array.from` / non-`Iterator.from` symbol-iterator bugs.

## Investigation + partial fix 2026-05-27 (dev-1605)

**Root cause (confirmed, refines the hypothesis above):** the assignment
`items[Symbol.iterator] = fn` is NOT mis-routed — the key arrives at `_safeSet`
as a real `symbol` and the function is stored under the correct
`[Symbol.iterator]` slot. The real problem is that `fn` is a **compiled Wasm
closure struct** — `typeof items[Symbol.iterator] === "object"`, not
`"function"`. Native `Array.from` / `Iterator.from` read the @@iterator method,
see a non-callable object, and throw
`%Array%.from requires that … items[Symbol.iterator] … be a function`. The
iterator object the closure returns (and its `.next`) are likewise Wasm
closures, so even invoking @@iterator isn't enough — the whole protocol must be
driven through `__call_fn_0`.

**Fixed in this PR (the `__array_from` host-import path):** added a module-level
`_drainWasmClosureIterable(obj, callbackState)` in `src/runtime.ts` that, when a
plain JS object's own @@iterator is a Wasm closure, invokes it via `__call_fn_0`,
then walks the returned iterator's (also-closure) `.next`, reading
`value`/`done` via `_safeGet` + `__sget_*`. Wired into the `__array_from`
import. Result: `built-ins/Array/from/iter-set-length.js` now **PASSES** (was
FAIL). Covered by `tests/issue-1320.test.ts` (2 cases: no spurious TypeError;
@@iterator invoked exactly once).

**Residual — the other 3 listed tests need other bridge paths (NOT fixed here):**

1. `iter-cstm-ctor.js` uses `Array.from.call(C, items)` → routes through
   `__extern_method_call` (obj=`Array.from`, method=`"call"`), hits native
   `Array.from` directly. Needs the same drain applied to the `.call`/`.apply`
   dispatch where the iterable is `wrappedArgs[1]`.
2. `Iterator/from/iterable-primitives.js` + `flatMap/...` use
   `Number.prototype[Symbol.iterator] = function*(){…}` (a **generator** on a
   prototype) and `Array.from(5)` (primitive → ToObject). Different facets:
   prototype-level @@iterator + primitive coercion + `function*` lowering.

**Separate lurking codegen bug (carved to #1684):** an iterator-result object
literal returned from a *nested closure* does not round-trip across the
Wasm→host boundary. The 4 listed tests use empty/trivial iterators so they
dodge this. This overlaps the iterator bridge family (#1620 / #1633) and the
live-mirror struct-field readback (#983d).

## `.call` / `Iterator.from` blocker confirmed (2026-05-27, dev-1605)

The `.call`-path drain is correctly wired (`__extern_method_call`,
`wrappedArgs[1]`), and `_drainWasmClosureIterable` is reached for
`Array.from.call(C, items)`. Traced through the real `runTest262File`
harness with `iter-cstm-ctor.js`:

- `items` arrives as a **plain JS object** (`var items = {}`, not a wasm
  struct), passed through unwrapped — correct.
- its own `[Symbol.iterator]` IS a wasm closure struct — drain guard passes.
- `__call_fn_0` is present; the drain invokes `callFn0(iterFn)` to run the
  `@@iterator()` closure.
- **`callFn0(iterFn)` returns `null`** instead of the iterator object
  `{ next: … }`. The closure's object-literal return value does not
  materialize to the host. The drain then bails at the `iteratorObj == null`
  guard and returns `null`, so the native `Array.from.call(C, items)` runs
  with the un-drained object and throws the "items[Symbol.iterator] … must be
  a function" error.

So the residual `.call` / `Iterator.from` failures are **NOT a host-bridge
gap** — the bridge is wired and reached. They are blocked on the
**closure object-literal return readback** carved to **#1684** (a codegen-layer
bug, not a runtime-bridge one). `iter-set-length.js` PASSES because its
iterator round-trips via the already-working `__array_from` path with a
structure that does materialize.

**Recommendation:** land the `__array_from` + `.call`/`.apply` drain wiring
(regression-free, banks 1 test + focused unit tests). The remaining 3 tests
(`iter-cstm-ctor`, `Iterator/from/iterable-primitives`,
`flatMap/iterable-primitives-are-not-flattened`) are gated on **#1684**
(closure-return struct readback) — they cannot go green at the host-bridge
layer. Status `in-review` for the partial PR; residual tracked in #1684 +
the iterator-bridge family (#1620/#1633).
