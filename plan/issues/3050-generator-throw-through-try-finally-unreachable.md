---
id: 3050
title: "GeneratorPrototype.throw() resumption through try/finally / try/catch hits `unreachable` (6 fails)"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: medium
created: 2026-07-05
task_type: bugfix
area: codegen
language_feature: generators, try-finally, abrupt-completion
goal: spec-completeness
test262_category: built-ins/GeneratorPrototype/throw
related: []
---

# #3050 — generator `.throw()` resumption through try/finally / try/catch → `unreachable`

## Source

Fresh default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02). **6** fails under
`built-ins/GeneratorPrototype/throw/*` with `error_category: unreachable`
(`returned # — assert ## at L#: assert.sameValue(unreachable, #, …)` — i.e. the
generator resumed to a Wasm `unreachable` instead of the correct catch/finally
target).

## Root-cause hypothesis

Calling `gen.throw(e)` must resume the suspended generator by **injecting the
exception at the current yield point** and running the try/catch/finally
resumption from there. The 6 failing files all exercise resumption where the
`yield` sits inside (or adjacent to) a `try`/`catch`/`finally` block:

- `try-catch-before-try.js`, `try-catch-following-catch.js`, `try-catch-within-catch.js`
- `try-finally-before-try.js`, `try-finally-following-finally.js`, `try-finally-within-finally.js`

The generator state-machine's throw-resumption path likely doesn't map the
resume PC / exception into the correct try-region handler table entry when the
suspension point is before/within/after a catch or finally clause — so control
falls through to an `unreachable` guard instead of the handler.

## Suggested approach

Trace the generator lowering's `.throw()` entry: how the injected exception is
routed to the resume point's enclosing try-region. Compare against the working
`.next()` resumption path. The 6 files are a tight, self-contained matrix
(before/within/following × catch/finally) — good for TDD.

## Acceptance criteria

- All 6 `GeneratorPrototype/throw/try-{catch,finally}-*` files pass.
- `.next()` resumption and non-generator try/finally are unaffected.
- No test262 regression.
