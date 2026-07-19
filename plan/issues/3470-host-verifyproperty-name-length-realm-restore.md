---
id: 3470
title: "Host-lane test262: verifyProperty name/length delete leaks across shared-realm strict rerun (runner-only, extends #3318)"
status: done
completed: 2026-07-19
assignee: ttraenkler/senior-dev
sprint: 72
created: 2026-07-19
priority: high
feasibility: low
task_type: bug
area: tooling
goal: test262-conformance
related: [3318, 3417, 3471]
origin: "Host<->standalone parity investigation, Cluster C2 sub-family (/workspace/.tmp/parity-findings.md) — ~370 js-host-lane test262 tests fail purely from harness realm pollution, not a compiler bug"
---

# #3470 — host-lane verifyProperty name/length restore gap (runner-only)

## Problem

~370 host-lane test262 tests fail as `"obj should have an own property
name"` (or `length`) purely from harness realm pollution — not a compiler
bug:

- `verifyProperty` (`test262/harness/propertyHelper.js:63-66` asserts
  `__hasOwnProperty(obj, name)`; the destructive probe is
  `isConfigurable()` at line 140, `delete obj[name]`) does `delete
obj[name]` to probe `configurable:true` and does **not** restore (these
  tests pass no `restore` option — see `propertyHelper.js:131-133`).
- The js-host lane uses SHARED real host builtins (both the in-process
  runner `tests/test262-runner.ts` and the sharded CI fork pool
  `scripts/test262-worker.mjs`). The sloppy run deletes e.g.
  `Date.prototype.getYear.name`; it is never restored before the
  auto-generated STRICT RERUN, so the strict run sees the missing
  sub-property and fails.
- Real Node passes (fresh realm per test). Standalone passes (fresh
  per-module builtins). Only the shared-host-builtin js-host lane leaks.
- `restoreHostBuiltins` (`tests/test262-restore-builtins.ts`, added by
  #3318) restores method **VALUES** (function identity) but NOT the
  `.name`/`.length` **sub-properties** of those methods — deleting
  `fn.name` never changes `fn`'s identity, so the existing `cur === orig`
  restore check is a no-op. Its `PROTOS` list also omits Date/TypedArray/
  DataView entirely.

### Timing verification (traced, not assumed)

`tests/test262-runner.ts`'s `runTest262File` (4357-4413) runs the primary
(sloppy) variant then, if it passed, the `strictRerun` variant — both via
`runOriginalHarnessVariant` (4179-4350), which calls
`restoreHostBuiltins()` at entry (4187) **and** in its `finally` block
(4348). So for the in-process runner, restore genuinely fires **between**
the sloppy run (which does the destructive delete) and the strict rerun
(which reads the sub-property) — same process, same realm, confirmed by
reading the call sites in context, not inferred from the fix landing.

For the CI sharded lane, `tests/test262-shared.ts` (912-969) dispatches
the primary and `strictRerun` variants as two separate
`pool.runTest(...)` jobs against `scripts/test262-worker.mjs`'s fork pool
(`scripts/compiler-pool.ts`); `restoreBuiltins()` runs before **and**
after every `doCompile` in every fork (worker.mjs:898,1762). Same-fork
reuse across a job stream isn't individually pinned, but a small number of
long-lived forks each handle many thousands of jobs across the run, so any
pollution left on a fork by one job's sloppy phase persists until cleaned
— extending the restore closes the leak class everywhere it can recur, not
just for a single test's own two-phase pair.

## Fix (runner-only, NO compiler change)

Extend the host-builtin restore to cover method `.name`/`.length`
sub-properties, and add the missing constructors, in both lanes (#3227
both-lanes-consistent rule):

- `tests/test262-restore-builtins.ts`: for every function captured as a
  data-property value across `PROTOS`, additionally snapshot + restore
  that function's own `.name`/`.length` property descriptors (not just the
  method's identity/value). Add `Date`, the `TypedArray` prototypes/
  constructors (`Int8Array`..`Float64Array`, `BigInt64Array`,
  `BigUint64Array`, and the abstract `%TypedArray%`), and `DataView` (+
  their prototypes) to `PROTOS`.
- `scripts/test262-worker.mjs`: mirror the same sub-property restore. The
  worker's existing method-VALUE snapshots (`_METHOD_SNAPSHOTS`,
  `_STATIC_SNAPSHOTS`) are curated per-object lists that don't cover every
  method (e.g. `annexB` methods like `Date.prototype.getYear` aren't
  listed at all), so the fix enumerates every function-valued own property
  on a comprehensive root-object list (existing guarded prototypes +
  Date/DataView/TypedArray-constructor entries) directly, rather than
  extending the curated lists — this closes the gap for annexB methods too
  and doesn't touch the FATAL/recycle validation paths (kept best-effort,
  since built-in function name/length descriptors are always
  `configurable:true` per spec).

## Repro (confirms the mechanism)

```js
delete Date.prototype.getYear.name;
// before=true delRet=true after=false
```

A fresh strict compile has the correct descriptor; the shared-realm host
lane does not, until restored.

Sample failing tests (`/workspace/.tmp/clC_set1.txt`):

- `annexB/built-ins/Date/prototype/getYear/name.js`
- `annexB/built-ins/RegExp/prototype/compile/name.js`
- `annexB/built-ins/String/prototype/substr/name.js`

## Acceptance criteria

- `restoreHostBuiltins()` (in-process) and `restoreBuiltins()` (sharded
  worker) restore a deleted `.name`/`.length` own property on a
  Date/TypedArray/DataView prototype method between test runs.
- Focused regression test: a `verifyProperty`-style configurability delete
  on a Date/TypedArray method's `.name` is restored before a subsequent
  compile/strict-rerun (unit-level, direct assertion on the restore
  functions).
- Zero compiler change; low risk (runner-only, best-effort restore, not
  wired into fork-recycle FATAL paths).

## CORRECTION (2026-07-19, during implementation) — revised impact estimate

**The original "~370 host tests flip fail→pass" estimate does not hold.**
Verified via the real CI baseline (`loopdive/js2wasm-baselines`
`test262-current.jsonl`) and an end-to-end run of the cited sample files
through `runTest262File` — see **#3471** (new issue, filed as part of this
investigation) for the full analysis. Summary:

- The 3 cited sample tests (and effectively the whole `name.js`/`length.js`
  `verifyProperty`-with-`writable:false` family, ~1,444 tests) currently
  fail on REAL CI with a **DIFFERENT, deeper signature**: `"Cannot assign
to read only property"` (433 of 987 current fails), not `"obj should
have an own property"` (only 13, and those are an unrelated bug in
  synthetic Promise-executor-function naming, not this mechanism at all).
- That deeper signature is a genuine **compiler bug** (#3471): a
  strict-mode assignment to a non-writable host property correctly throws
  `TypeError` (`src/runtime.ts:3979`, intentional per #2017) but the
  compiled `try/catch` doesn't correctly catch/classify it as `instanceof
TypeError`, so it propagates uncaught. This happens on a **fresh,
  never-mutated realm too** (it doesn't depend on prior state), which is
  why it dominates on CI's worker-pool architecture (low same-fork
  correlation between a single test's own sloppy/strict phases) while THIS
  issue's masking (`"obj should have an own property"`) is really only
  reliably observable in the **single-process in-process runner**
  (`tests/test262-runner.ts`, 100% same-realm guarantee between phases).
- **Revised scope for #3470**: still a real, confirmed, zero-risk fix —
  restores in-process-runner correctness (matters for
  `pnpm run test:262:validate-baseline`, `/smoke-test-issue`, local
  dev/debugging sessions that run tests in-process) and closes a genuine
  realm-isolation gap in `restoreHostBuiltins`/`restoreBuiltins`. Its
  **real CI/merge_group flip count is expected to be near-zero** until
  #3471 also lands — the two together are what's needed to actually flip
  the ~370-1,444 test family. Landing #3470 alone is still worthwhile
  (correctness + it's the smaller, lower-risk half; #3471 is compiler-side
  and explicitly out of this issue's "runner-only, no compiler change"
  scope) but should not be reported as delivering ~370 CI flips.
