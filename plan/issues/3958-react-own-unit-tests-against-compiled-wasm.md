---
id: 3958
title: "Run React's own unit tests against compiled React, replacing hand-transcribed vectors"
status: done
sprint: current
created: 2026-08-01
updated: 2026-08-01
completed: 2026-08-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: test
area: dogfood
language_feature: compiler-internals
goal: dogfood
---

# Run React's own unit tests against compiled React

## Problem

`tests/dogfood/react-upstream-suite.mjs` pinned React's real source tag and
verified its immutable commit — and then ran **five hand-transcribed
"source-attributed public-API vectors"** written by the harness author. The
pin was real; the tests were not React's.

That is the failure mode the dogfood corpus exists to avoid. A harness-authored
vector proves the harness author's mental model of React, at a granularity the
author chose, on the cases the author thought to write. It cannot surface a bug
nobody anticipated, which is the entire point of compiling a real package.
`tests/dogfood/README.md` said so itself, promising to follow "the existing
Acorn/React precedent" — but only acorn actually had one, via
`acorn-official-suite.mjs` running acorn's real ~3,500-case suite.

React is harder than acorn, and that is why it had been deferred. Acorn's
`test/driver.js` is deliberately decoupled from any acorn build: hand it a
`parse` function and it runs. React's suite is welded to Jest,
`internal-test-utils`, ReactDOM and a jsdom `document`; there is no upstream
entry point that can be handed a `React` and asked to run.

## What was done

`tests/dogfood/react-upstream-extract.mjs` reads React's test **files** verbatim
from the verified commit, transpiles their JSX with the classic runtime
(`<div/>` → `React.createElement('div', null)` — exactly what React's own jest
transform does), and lifts each `it(...)` out with its enclosing `describe`
scope and `beforeEach` prelude. Test names, bodies and assertions are
upstream's; nothing is transcribed or reworded.

The pin now names React's **entire** public `packages/react/src/__tests__`
directory (18 files, 273 upstream tests) rather than two hand-picked files, and
which tests are admitted is decided by the extractor at run time.

Three rules keep the resulting number honest:

1. **Admission is conservative and counted.** A test is admitted only if it
   needs nothing but React itself. ReactDOM, `act`, the console-assertion
   helpers, `jest.*`, a `document`, `__DEV__`, async scheduling, or a name that
   only existed on a prelude statement the harness had to drop — each is
   rejected _with its reason recorded_, and the rejection tally is reported next
   to the pass count. The admitted slice can never be mistaken for the suite.
2. **The `expect` shim implements only the matchers the admitted tests use.** A
   test using anything outside `SUPPORTED_MATCHERS` is rejected rather than
   scored against an approximation of Jest. The same shim SOURCE is compiled
   into the Wasm module and evaluated for the native oracle, so a divergence is
   always the compiler and never a difference between two hand-written shims.
3. **A test the harness cannot reproduce natively is not evidence about the
   compiler.** It is excluded from the score under its own
   `harness-incompatible` bucket instead of being counted as a compiler bug.

A test that breaks compilation is quarantined and reported by name, never
silently removed.

## Result

|             | before                 | after                                |
| ----------- | ---------------------- | ------------------------------------ |
| test source | 5 hand-written vectors | 273 real upstream tests, 56 admitted |
| scored      | 5                      | 53                                   |
| passing     | 2                      | **39**                               |

The 39 is after the two compiler fixes this work uncovered (#3959, #3960); the
suite scored 32/53 before them. The remaining 14 failures are real and stay
enumerated in the report — most of them one root cause, filed as #3961.

## Acceptance criteria

- [x] The corpus is React's own test sources at a verified commit, not
      harness-authored vectors.
- [x] Every upstream test is either scored or rejected with a recorded reason;
      `admitted + rejected == upstreamTestsSeen` is asserted.
- [x] Natively-unreproducible tests are scored in their own bucket, never as
      compiler failures.
- [x] The vitest wrapper enforces a pass FLOOR (regression gate), not a target,
      so the remaining frontier stays visible.
- [x] The obsolete `react-upstream-vectors.mjs` is deleted, not left beside the
      real suite where it could be mistaken for it.

## Permanent test reference

`tests/dogfood/react-upstream-suite.test.ts` — pin/commit assertions run
always; the full run is gated behind `DOGFOOD_REACT_UPSTREAM=1` (it compiles a
283 KB module) and enforces `passed >= 39`, `scored >= 50`.

```bash
pnpm run dogfood:react-upstream-suite
DOGFOOD_REACT_UPSTREAM=1 pnpm exec vitest run tests/dogfood/react-upstream-suite.test.ts
```

## References

- `tests/dogfood/acorn-official-suite.mjs` — the precedent, and the contrast:
  acorn ships a build-independent driver, React does not.
- #3959, #3960 — compiler bugs this suite found and this PR fixes.
- #3961 — the dominant remaining failure cluster.
