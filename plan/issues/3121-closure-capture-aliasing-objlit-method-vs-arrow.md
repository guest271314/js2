---
id: 3121
title: "Closure capture aliasing: object-literal method writes a hoisted GLOBAL while a sibling arrow reads a ref-cell — same captured local, two stores"
status: ready
created: 2026-07-09
reporter: fable-2978
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
related: [2978, 2980]
sprint: current
horizon: m
---

# Closure capture aliasing: obj-literal method vs arrow disagree on a captured local's storage

## Problem

When a **function-local** variable is captured BOTH by an object-literal method
and by a sibling closure (arrow), the two lowerings pick **different storage**:
the object-literal method's body writes a **hoisted module global**, while the
arrow reads a **closure env ref-cell**. Writes through one are invisible to the
other — silent wrong results.

Minimal repro (verified on main @7b8ade85c7a58, `--target standalone`, also
wrong on gc-host):

```ts
export function test(): number {
  var c = 0;
  const o = {
    inc() {
      c += 1;
    },
  };
  const f = () => c;
  o.inc();
  o.inc();
  return f() * 10 + c; // expected 22 — returns 0
}
```

WAT evidence (from the #2978 investigation, canonical test262 file
`AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`
wrapped by the runner): the iterator's `return()` method increments
`$global$16` (`global.set (f64.add (global.get $global$16) 1)`), while the
async arrow reads `returnCount` via `struct.get $44 0` on a captured ref-cell
param. Two stores, one variable.

## Impact

- Blocks the FULL pass of `for-await-next-rejected-promise-close.js` on the
  widened-carrier standalone lane: after #2978's fix the rejection routing and
  IteratorClose are spec-correct (`e === "reject"` passes, `return()` runs),
  but the test's `returnCount` assert reads the stale cell → `fail` instead of
  `pass`. The same wrapped-in-`test()` harness shape (locals captured by both
  an obj-literal method and the `asyncTest` arrow) is common across the
  AsyncFromSyncIteratorPrototype / for-await families — fixing this converts
  a cluster, not one file.
- Generic correctness hazard for any module mixing obj-literal methods and
  closures over the same function-local mutable state.

## Where to look

- The escape/hoist analysis that promotes captured locals to module globals for
  object-literal METHOD bodies (declarations/literals lowering) vs the ref-cell
  capture used by arrow/function closures (`closures.ts`). The fix is to make
  both consumers agree on ONE store per binding — presumably the ref-cell
  (globals can't be per-invocation).
- Note top-level (module-scope) `var`s do NOT alias — both lower to the same
  module global; the bug is specific to **function-local** captures (the
  test262 runner wraps every test body in `function test()`, so the harness
  hits the local case pervasively).

## Acceptance

- The repro returns 22 on gc-host, standalone, and wasi.
- `for-await-next-rejected-promise-close.js` passes on the widened-carrier
  standalone lane (with #2978 landed) — verify with
  `JS2WASM_ASYNC_CARRIER_WIDEN=1` via `runTest262File(..., "standalone")`.
- 0 test262 regressions.
