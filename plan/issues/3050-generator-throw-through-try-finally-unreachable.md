---
id: 3050
title: "GeneratorPrototype.throw() resumption through try/finally / try/catch hits `unreachable` (6 fails)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: hard
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

## Investigation (2026-07-05, dev-3042) — reassessed: SENIOR / architectural, not a bounded [S] dev fix

**All 6 files route to the LEGACY eager-buffer generator lowering, which cannot
inject a `.throw()` at a suspended yield.** Confirmed root cause, deeper than the
"resume-PC handler-table" hypothesis:

1. The NATIVE lazy state-machine lowering (`src/codegen/generators-native.ts`)
   explicitly **rejects** these shapes in `lowerStatements`:
   - `if (stmt.catchClause || !stmt.finallyBlock) return fail();` — any `try`
     with a **catch clause** across a yield is unsupported (the 3 `try-catch-*`
     files).
   - `if (!statementsAreYieldFree(stmt.finallyBlock.statements)) return fail();`
     — a **yield inside the finally** is unsupported (all 3 `try-finally-*`
     files put `yield 3` in the finally).
   The author's own note at generators-native.ts:2037 flags this: *"try/catch
   across yield stays the next slice."*

2. Rejected generators fall back to the **legacy eager model**
   (`src/codegen/function-body.ts:1052+`, mirrored in `closures.ts` /
   `class-bodies.ts`): the whole body is **evaluated eagerly**, buffering every
   yield into `__gen_create_buffer`, then wrapped by `__create_generator` which
   replays the buffer. Because the body already ran to completion, the statement
   after a suspended `yield` (`unreachable += 1`) executes **during eager eval,
   before `.throw()` is ever called** — so `iter.throw()` cannot skip it.
   Verified: a minimal `try { yield 2 } finally { yield 3; unreachable += 1 }`
   returns `unreachable === 1` (spec requires `0`).

**Why this is not a bounded dev fix.** Correct `.throw()`-at-yield semantics
require the LAZY native state machine to (a) permit yields inside `finally`,
(b) support `try/catch` across yields, and (c) route an injected throw at a
suspended yield to the enclosing try-region — running/exiting the correct
`finally`, entering the matching `catch`, and propagating otherwise
(§27.5.3.4 GeneratorResumeAbrupt + AbruptCompletion through the try model). That
is the deferred generator-state-machine slice, not a localized bug. The eager
fallback is architecturally incapable of it (no suspension point survives).

**Recommendation:** re-scope to **senior-developer** (or `/architect-spec`
first). Bumped `feasibility: hard`, `horizon: m`. Suggested plan: extend
`generators-native.ts` try handling to model try-regions with per-yield
membership + a resume-mode router (reuse the existing `abruptResume` /
`MODE_THROW` machinery, generalised from finally-only to catch + yield-in-finally),
then remove the two `fail()` guards. TDD against the tight 6-file matrix
(before/within/following × catch/finally).
