---
id: 3284
title: "Make the compiler compatible with the original (unmodified) test262 harness — assert.js property-call dispatch + Promise.then microtask gap"
status: ready
sprint: current
created: 2026-07-15
priority: high
feasibility: hard
model: opus
horizon: l
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: promises, prototype-methods
goal: test262-conformance
related: [3285]
---

# #3284 — compiler compatibility with the real, unmodified test262 harness

## Context

Our own test262 conformance number (JS-host: 76.6%) is measured through
`tests/test262-runner.ts`'s `wrapTest()`/`buildPreamble()`: the real upstream
`test262/harness/*.js` files (`assert.js`, `sta.js`, `compareArray.js`, etc.)
are **never used** — a hand-written synthetic TypeScript preamble replaces
them entirely, and every test body is mechanically rewritten (renamed assert
calls, stripped arguments, etc.) before compilation. See #3285 for the
correctness issues that rewrite introduces.

Independently, [test262.fyi](https://test262.fyi) (an external, third-party
conformance tracker for many JS engines) added a js2wasm integration that
compiles each test file with the **literal, unmodified upstream harness**
(`assert.js` + `sta.js` + `includes` concatenated verbatim ahead of the raw
test body — the same thing every other engine on that site gets), using our
public `compile()` API with `target: 'gc'`. That run measured **3,996 / 53,406
(7.48%)** — dramatically lower than our own 76.6%, because it hits compiler
bugs our rewrite pipeline was specifically built to route around.

This issue is about closing that gap **in the compiler**, not in the harness:
raw, un-rewritten test262 harness files should compile and run correctly.
That's a meaningfully different (and arguably more important) bar than "the
custom preamble scores well" — it's also what any other external tool,
sandbox, or user compiling ordinary code that happens to use these same
patterns will hit.

## Two confirmed root causes

Both were isolated directly against a freshly built `compiler-bundle.mjs`
(`esbuild src/index.ts --bundle --platform=node --format=cjs`, no other
scaffolding), independent of any test262-fyi-specific wrapping choices — so
these are compiler bugs, not artifacts of how that harness invokes us.

### 1. Calling a function assigned as a property after declaration fails

`assert.js`'s actual, real implementation shape is:

```js
function assert(mustBeTrue, message) { /* ... */ }
assert.sameValue = function (actual, expected, message) { /* ... */ };
assert.notSameValue = function (actual, expected, message) { /* ... */ };
assert.throws = function (expectedErrorConstructor, func, message) { /* ... */ };
```

i.e. `assert` is declared as a function, then given callable properties via
plain assignment afterward — the single most common pattern in the entire
harness. Minimal repro (target: `gc`, no wrapping needed — reproduces at
top-level or inside a wrapped `export function test() {}`, same result
either way):

```js
function assert(mustBeTrue, message) {
  if (mustBeTrue === true) return;
  throw new Error("assert failed: " + message);
}
assert.sameValue = function (actual, expected, message) {
  if (actual === expected) return;
  throw new Error("sameValue failed: " + message);
};
console.log(typeof assert.sameValue); // prints "function" — property read + typeof are fine
assert.sameValue(1, 1, 'should be equal'); // throws TypeError: sameValue is not a function
```

`typeof assert.sameValue` correctly reports `"function"` immediately before
the failing call — so the property is stored and readable, but the compiled
**call site** doesn't resolve/dispatch it as callable. Likely somewhere in
how call-target type inference handles a property added to a function object
after its declaration (as opposed to a method defined inline in an object
literal, or a property known statically at the declaration site) — worth
comparing against how `compileCallExpression`/`compileReceiverMethodCall`
(see #3282's LOC table) resolve the callee's type for this exact shape.

This alone blocks the overwhelming majority of raw test262: `assert.js` is
concatenated ahead of nearly every test file test262-wide.

### 2. `Promise.prototype.then()` callbacks never fire

```js
console.log('before promise');
Promise.resolve(42).then(function (v) {
  console.log('in then, v=', v); // never printed — confirmed with an explicit
                                  // 500ms setTimeout wait afterward, not just
                                  // "hasn't happened yet by the next line"
});
console.log('after promise setup');
```

`src/runtime.ts` bridges `Promise_then`/`Promise_new`/`Promise_resolve` etc.
to the real host `Promise` (see the `Promise_then` case: `p.then(_maybeWrapCallable(cb, 1, callbackState))`
where `p` is a genuine native `Promise`), so in principle this should Just
Work via Node's own microtask queue — but the callback provably never runs,
even after the compiled function that scheduled it has returned and control
is back in plain host JS with time to spare. This breaks:
- the standard test262 async-test convention (`doneprintHandle.js`'s
  `$DONE`/`print('Test262:AsyncTestComplete')`, driven by a `.then()`/`.catch()`
  chain, not `async`/`await`)
- any real-world code using `.then()`-chained Promises rather than
  `async`/`await` (README lists async/await as "Solid" but doesn't
  distinguish `.then()` chaining — this suggests the CPS/state-machine path
  for `async function` works while the general `Promise.prototype.then`
  entry point does not, which is a narrower, more diagnosable bug than "async
  is broken").

Confirm this is specifically about *host-visible* callback firing, not about
`.then()` being unimplemented — the promise itself resolves fine (no error,
no unhandled rejection surfaces either) and `#test262-worker.mjs`'s own
`testFn()` invocation model calls the wrapped test **synchronously and
expects a synchronous return value** (`const ret = testFn();` — see #3285),
so it's plausible our internal harness has simply never exercised this path
naturally, and the gap has been invisible internally.

## Why this matters beyond test262.fyi's number

Both patterns above are not test262 idiosyncrasies — "assign a method to a
function after declaring it" and "resolve a promise chain with `.then()`"
are extremely common, unremarkable JavaScript. A compiler that silently
produces wrong behavior for either (no compile error, no runtime error in
case 1 until the exact call site; complete silence in case 2) is a
correctness gap independent of any test-harness framing.

## Suggested approach

1. Reproduce both minimal cases above directly (no test262 needed) and get a
   WAT/codegen diff between "property assigned inline in an object literal"
   (works, presumably) vs. "property assigned via `obj.prop = fn` after
   declaration" (broken) for case 1.
2. For case 2, trace whether `Promise.resolve(x).then(cb)` written directly
   in source actually lowers to the `Promise_then` host import at all, or
   takes a different (GC-native, non-host) codegen path that never reaches
   `src/runtime.ts`'s bridge — the discrepancy between "the bridge looks
   correct" and "the callback never fires" suggests the compiled call site
   isn't reaching that import.
3. Once both are fixed, re-run the raw-harness case (unmodified
   `test262/harness/assert.js` + `sta.js`, no `wrapTest` rewriting) locally
   and measure the delta — this issue's acceptance bar is a large jump in
   that specific (non-rewritten) pass rate, not the existing rewritten-harness
   number.

## Acceptance criteria

- Both minimal repros above pass (no thrown error, `"in then, v= 42"` prints).
- The real, unmodified `test262/harness/assert.js` + `sta.js`, concatenated
  ahead of a test body with zero `wrapTest`-style rewriting, compiles and
  scores correctly for a representative batch of currently-failing-for-this-
  reason test262 files.
- No regression in the existing rewritten-harness JS-host pass rate.
