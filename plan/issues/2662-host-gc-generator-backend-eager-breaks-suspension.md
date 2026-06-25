---
id: 2662
title: "host (gc) generator backend is EAGER-buffered — breaks lazy/suspension semantics on the default path (architecture)"
status: ready
created: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, architecture
language_feature: generators
goal: spec-completeness
related: [1344, 1665, 2157]
test262_bucket: built-ins/GeneratorPrototype
---

# #2662 — host (gc) generator backend is eager-buffered (architectural correctness gap)

Split out of **#1344** (2026-06-25, sd-2651) because it is **bigger than #1344**
and gates whether #1344's state-machine slices (S-B/S-C) move the conformance
dashboard at all.

## The gap

There are **two** generator backends:

- **Native lazy state machine** (`src/codegen/generators-native.ts`) — correct
  suspension semantics, but **standalone/wasi-ONLY** (`generators-native.ts:849`
  `if (!noJsHostTarget(ctx)) return false`).
- **Host runtime** (`src/runtime.ts`) — used in **default gc mode** — is an
  **EAGER-YIELD BUFFER**: it runs the **entire** generator body up front into a
  `buf: any[]` (runtime.ts:135), then `.next()` just drains the buffer.

The eager backend **cannot** implement lazy suspension, so it is wrong for every
observable that depends on when the body runs:

- side-effect timing (statement after a `yield` must not run until resumed);
- `.return()` / `.throw()` **interrupting** a generator suspended in a `try`;
- `finally` running on abrupt completion at the right time;
- infinite generators (eager buffer never terminates).

### Proof (verified, current `main`)

```ts
let se = 0;
function* g() { se = 1; yield 1; se = 2; yield 2; se = 3; }
g();            // create, NO .next() yet
// gc/host:    se === 3   (whole body ran eagerly — WRONG)
// standalone: se === 0   (correctly lazy)
```

## Why this gates #1344 (and any generator-conformance work)

The test262 conformance runner wraps every test in `export function test() { … }`
(`tests/test262-runner.ts:2370`, `wrapTest`). A test's top-level `function* g()`
therefore becomes a **generator nested inside `test()`**, and (for the
GeneratorPrototype tests, which have no class so their `var`s are NOT hoisted to
module scope) it **captures** the `test()`-local vars. A capturing nested
generator hits `generatorCapturesOuterScope` (`generators-native.ts:901`) →
**bail to the host EAGER path even under `--target standalone`.**

Verified: the wrapped `return/try-finally-within-try.js` keeps `var inTry`,
`var inFinally`, and `function* g()` all INSIDE `test()` (capturing), so it runs
on the eager host path in BOTH lanes. The conformance dashboard's
`runTest262File` defaults to gc/host (`scripts/runner-bundle.mjs:64253` — no
`target` arg). **So test262 generators are measured on the eager host path.**

⇒ Building the native state machine for catch / yielding-finally (#1344 S-B/S-C)
would move the dashboard by **ZERO** until this gap is closed, because the
measured path never reaches the native backend for these tests.

## Options (architecture decision — needs the lead / an architect)

1. **Make the native lazy path handle CAPTURES** (so a nested/capturing generator
   goes native instead of bailing to eager host). This re-routes the wrapped
   test262 generators onto the correct backend and is likely the highest-leverage
   single change — it may flip a large swath of generator tests at once AND
   unblock #1344 S-B/S-C. Scope: the native state struct currently has slots for
   `this` + own params only, not captures (`generators-native.ts:899-902`);
   capture support means materializing captured bindings as ref-cell fields in the
   state struct (the closure-capture pattern already used elsewhere).
2. **Make the host gc backend lazy** (a proper resumable coroutine in
   `src/runtime.ts` instead of the eager buffer). Large rewrite; the eager buffer
   was a deliberate simplification. Likely out of scope / lower leverage than (1).
3. **Measure conformance on the standalone lane for generators** — does not fix
   the gc correctness gap, and captured generators still bail to eager even under
   standalone, so this alone is insufficient.

**Recommendation (sd-2651):** Option 1 (native captures) — it fixes the
measured-path selection (the #1344 gating sub-question), is bounded by the
existing closure-capture machinery, and unblocks the #1344 state-machine slices.
Decide before committing #1344 S-B/S-C.

## Acceptance

- A capturing nested generator runs LAZILY (the side-effect-timing proof above
  returns 0 in gc mode, or the wrapped test262 generators are routed to the
  native lazy path), without regressing the existing generator suites.
- Re-measure the GeneratorPrototype `return`/`throw` buckets afterward; #1344
  S-B/S-C then have a measurable target.

## Routing

Architecture decision first (lead/architect): option 1 vs 2 vs 3. Then a
senior-dev build. Blocks #1344 S-B/S-C from moving the dashboard.
