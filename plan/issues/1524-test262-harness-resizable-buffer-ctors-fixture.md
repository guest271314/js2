---
id: 1524
title: "test262 harness: TypedArray `ctors` fixture not visible in resizable-buffer tests"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: test-runner
language_feature: test262-harness, typed-array
sprint: Backlog
es_edition: n/a
test262_category: built-ins/Array/prototype, built-ins/TypedArray
test262_count: 259
related: []
---
# #1524 — `ctors` fixture not exposed in resizable-buffer test262 tests

## Problem

202 test262 tests fail with `ctors is not defined`. All of them are
resizable-ArrayBuffer iteration tests for `Array.prototype.*` /
`TypedArray.prototype.*`, which include the shared harness file
`resizableArrayBufferUtils.js`. That helper declares a top-level
`var ctors = [...]` listing the typed-array constructors to iterate
over. Our test262 runner appears to either:

1. fail to inline the helper into the compiled module,
2. inline it but lose the `var` binding because of unified-module
   scoping, or
3. compile the helper, but mark `ctors` as an unresolved external
   when the test body references it.

## Failing test examples

- `test/built-ins/Array/prototype/every/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/findIndex/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/findLastIndex/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/forEach/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/indexOf/coerced-searchelement-fromindex-shrink.js`

Error (all identical):

```
L49:3 ctors is not defined
```

## Investigation hints

- `harness/resizableArrayBufferUtils.js` in the test262 worktree —
  inspect what the file declares.
- Compare with how `assert.js` / `sta.js` are included. They appear to
  reach test bodies fine (other top-level decls work).
- The fact that line `49` / `41` is consistent across hundreds of
  tests suggests the helper compiles but its top-level `var` does not
  reach the test export scope.

## Acceptance criteria

- The 5 example tests above compile and execute at least to their
  first assertion (pass or assertion-fail, not `ctors is not defined`).
- No new compile errors elsewhere.

## Estimated impact

**202 test262 fails** unblocked — many will still fail downstream on
resizable-buffer semantics, but converting CE → assertion fail makes
the underlying gaps visible for follow-up.

## Harvest update — 2026-06-19 (run `e9579720`, dated 2026-06-18)

Default-lane cascade grew **202 → 227**. The `resizableArrayBufferUtils.js`
include (`defines: [floatCtors, ctors, MyBigInt64Array,
CreateResizableArrayBuffer, …]`) still never binds its fixtures, so downstream
references throw `ReferenceError`: `ctors is not defined` ×175,
`floatArrayConstructors` ×21, `nonClampedIntArrayConstructors` ×18,
`floatCtors` ×5, `typedArrayConstructors` ×8 (plus `byteConversionValues` ×17
from `byteConversion.js`). Root cause unchanged. Still `backlog`; recorded
count bumped to 227.

## Harvest update — 2026-07-03 (default run `20260703-092808`, standalone run confirmed fresh via `runs/index.json`)

Confirmed cross-lane — same root cause fires in **both** test262 lanes:

- **Default lane: 259** fails, `ctors is not defined` still the dominant
  signature (`ReferenceError`), same `resizableArrayBufferUtils.js`
  top-level-`var` scoping gap.
- **Standalone lane: 175** fails, same signature
  (`built-ins/TypedArrayConstructors/ctors/buffer-arg/*`,
  `built-ins/Atomics/*`, `built-ins/Array/prototype/fill/resizable-buffer.js`
  among the samples) — confirms the harness-scoping bug is orthogonal to
  the standalone/host-import substrate work, i.e. fixing it here benefits
  both lanes independently.

Root cause and fix scope unchanged from the 2026-06-19 update. Recorded
count bumped to 259 (default); still `feasibility: easy`, still `backlog`.
Flagging as a good candidate for promotion to `sprint: current` — cheap,
well-scoped, and now confirmed to unblock **259 + 175 = 434** combined
test262 fails across both lanes (PO call, not made here).

**Harvest 2026-07-05 re-confirm:** still 259 default-lane `is not defined`
records (`ctors` / `floatArrayConstructors` / `byteConversionValues` /
`nonAtomicsFriendlyTypedArrayConstructors`), and this fixture gap is
additionally the upstream root cause of the **1,496** default-lane
"vacuous harness-wrapper" fails filed under #2940 (the harness helper throws
before the assertion callback runs). Blast radius is materially larger than
the recorded 434. Reiterating: cheap, `feasibility: easy`, high-leverage —
strongest single non-substrate default-lane candidate for `sprint: current`.
