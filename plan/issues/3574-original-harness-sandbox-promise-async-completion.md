---
id: 3574
title: "js2-test262 (originalHarness mode): async completion never observed for real Promise/await tests — likely cross-realm Promise identity from the vm.createContext sandbox"
status: ready
sprint: current
created: 2026-07-17
priority: high
feasibility: medium
model: opus
horizon: m
reasoning_effort: high
task_type: bugfix
area: test-infrastructure, runtime
language_feature: promises, async-await
goal: test262-conformance
related: [3284, 3285, 3349]
---

# #3574 — `originalHarness` sandbox's async-completion detection never fires for real Promise timing

## Context

Found while switching [test262.fyi](https://test262.fyi)'s js2wasm integration
from a hand-rolled compile+instantiate harness (this project's own
`compile()`/`WebAssembly.instantiate` API) to the npm-shipped `js2-test262`
CLI (`dist/test262-fyi-cli.js`, backed by `dist/test262-worker.js`) — the
purpose-built executor this project ships specifically for running the real,
unmodified `test262/harness/*.js` files (see #3284/#3285/#3349 for that
broader context). It's a clear upgrade over the hand-rolled approach for most
cases (proper fixture-graph resolution, real negative phase/type
verification instead of string-matching) — but async-flagged tests reliably
fail to signal completion through it.

## Repro

Minimal case, run via the shipped `js2-test262` bin directly (no test262
checkout content needed beyond the file itself):

```js
// trivial-async.js2wasm
function print(x) { console.log(x); }
/*---
flags: [async]
---*/
function $DONE(err) {
  if (err) print('Test262:AsyncTestFailure:' + err);
  else print('Test262:AsyncTestComplete');
}
Promise.resolve(42).then(function (v) {
  $DONE();
}, $DONE);
```

```
$ js2-test262 --target gc --test262-root ./test262 --engine-suffix js2wasm trivial-async.js2wasm
async completion marker not observed
$ echo $?
1
```

**A synchronous, immediate `$DONE()` call (no Promise involved) works
correctly** through the exact same CLI invocation — confirming the
`print`/`console.log`-interception plumbing itself (`consoleProxy` →
`appendHarnessOutput` → the worker's marker-search loop) is fine in general:

```js
// same file, but $DONE() called immediately, no Promise
function $DONE(err) { /* ... */ }
$DONE();  // -> exits 0, "Test262:AsyncTestComplete" observed correctly
```

The failure is specific to completion signaled from inside a `.then()`
callback (confirmed with both plain `Promise.resolve().then()` and a real
`async function` + `await` + `.then()`), i.e., anything requiring the
compiled code's promise machinery to actually run a microtask before
`$DONE()` fires.

## Where this diverges from the already-fixed #3284 RC2

#3284 RC2 fixed a related-sounding "`Promise.then()` callback never fires"
issue by wiring `__setExports`/`deferToExports` in `src/runtime.ts`'s
`callback_maker` host bridge. **That fix is not the gap here** — I confirmed
`dist/test262-worker.js` already calls the exports-wiring hook correctly:

```js
if (typeof importObj.setExports === "function") {
  importObj.setExports(instance.exports);
}
```

and independently verified `buildImports(...).setExports` is a real,
present function on the object `dist/runtime.js`'s `buildImports` returns
(checked directly: `Object.keys(buildImports(...))` includes `'setExports'`).
So the RC2 wiring is present and correct in this path — this is a second,
different gap.

## Root-cause hypothesis: cross-realm `Promise` from the harness sandbox

`buildOriginalHarnessSandbox` (`dist/test262-worker.js`) creates a genuine,
separate `node:vm` context for `originalHarness` mode:

```js
function buildOriginalHarnessSandbox(consoleProxy) {
  const sandbox = Object.create(null);
  const context = createContext(sandbox);
  for (const name of ORIGINAL_HARNESS_SANDBOX_GLOBALS) {
    try { sandbox[name] = runInContext(name, context); } catch {}
  }
  ...
}
```

`ORIGINAL_HARNESS_SANDBOX_GLOBALS` (= `SANDBOX_GLOBAL_NAMES`) **includes
`"Promise"`** alongside `Array`/`Object`/`Map`/etc. This sandbox is then
passed into `buildImports(..., { globalSandbox: harnessSandbox })` for
`originalHarness` runs. That means compiled test code's `Promise` resolves
to the **sandboxed `vm.Context`'s own `Promise` constructor** — a distinct
realm from the worker process's real, outer `Promise` — while the
async-completion detector itself polls using the **worker's own native
Promise/timer** (`await new Promise(r => setTimeout(r, 10))` in the
`findMarker` polling loop).

My working hypothesis (not fully root-caused — this needs someone with
direct visibility into `resolveImport`'s `Promise_then`/`Promise_resolve`
bridge functions in `src/runtime.ts` to confirm precisely, since it's a
cross-realm identity question I can observe the symptom of but can't fully
trace through minified/bundled dist code): the compiler's `Promise_then`/
`Promise_resolve`/`Promise_new` runtime bridges
(`src/runtime.ts`, e.g. `if (name === "Promise_resolve") return (val) =>
Promise.resolve(val);`) close over whichever `Promise` is lexically visible
at the point those bridge functions are constructed — likely the runtime
module's own native (outer-realm) `Promise` — while other parts of the
pipeline (TypeScript's own type resolution of the global `Promise` type, or
any `instanceof Promise`/`typeof x.then === 'function'` identity check done
against the *sandboxed* constructor) may resolve to the **sandbox's**
`Promise` instead. A cross-realm mismatch there (native `Promise` instance
vs. sandboxed `Promise` constructor reference) is a well-known way for
promise-shaped dispatch logic to silently stop matching without throwing —
consistent with the symptom here: no error is raised, no unhandled
rejection, the callback just never observably fires within the 1-second
polling deadline.

## Blast radius

```
grep -rl "flags:.*async\|^\s*- async" test262/test/ | wc -l
5616
```

**5,616 of 53,406 test262 files (10.5%) carry the `async` flag.** If this
gap is as broad as the minimal repro suggests (both plain `.then()` and
`async function`/`await` chains affected), essentially all of them would
currently fail through `js2-test262`'s `originalHarness` path regardless of
whether the underlying async logic being tested is otherwise correct —
comparable in scale to #3349's `propertyHelper.js` finding.

## Suggested approach

1. Confirm precisely whether `Promise` (and by extension `.then` identity)
   crosses the sandbox boundary inconsistently — instrument
   `buildOriginalHarnessSandbox`'s `sandbox.Promise` vs. the outer
   `globalThis.Promise` the worker itself runs under, and check whether the
   compiled test's `Promise.resolve(...)` return value is `instanceof` the
   *sandbox's* `Promise` or the *outer* one.
2. If confirmed, the likely fix is making the compiled code's promise
   identity consistent with whichever `Promise` the worker's own
   `findMarker` polling loop (and Node's real microtask queue) actually
   drains against — either by not sandboxing `Promise` at all (real
   `Promise` semantics don't meaningfully differ per-realm the way,
   say, poisoned-prototype isolation for `Array`/`Object` does — the
   sandboxing of `Promise` specifically may not have been a deliberate
   choice so much as an artifact of including it in the same blanket
   `SANDBOX_GLOBAL_NAMES` list as everything else), or by ensuring the
   `Promise_then`/`Promise_resolve`/etc. bridge functions explicitly use
   `harnessSandbox.Promise` when `originalHarness` mode is active.
3. Re-run the minimal repro above and a representative sample of the 5,616
   async-flagged test262 files once changed.

## Acceptance criteria

- The minimal repro above (plain `Promise.resolve().then($DONE)`) passes
  through `js2-test262 --target gc`.
- A real `async function` + `await` + `.then()` chain (the second repro
  variant) also passes.
- A representative sample of async-flagged test262 files run through
  `js2-test262` shows a material pass-rate jump for that category
  specifically, not just the synthetic repros.
- No regression in the already-passing synchronous `$DONE()` case.
