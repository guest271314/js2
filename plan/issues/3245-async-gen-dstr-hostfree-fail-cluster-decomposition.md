---
id: 3245
title: "async-gen dstr host-free-FAIL cluster: root decomposition + error-path mirage + runner warm/cold artifact"
status: ready
sprint: current
priority: medium
feasibility: hard
reasoning_effort: high
task_type: analysis
area: codegen, standalone, test-infrastructure
language_feature: async-generators, destructuring, iterator-protocol
goal: standalone-mode
umbrella: 1781
related: [3244, 3132, 2580, 1543, 1042]
created: 2026-07-13
origin: "opus-asyncthen — scoping the async-gen dstr host-free-FAIL cluster (#3132 follow-up). Tracks the roots that are NOT #3244, and the two measurement artifacts that made this cluster look bigger/other than it is."
---

# #3245 — async-gen dstr host-free-FAIL cluster decomposition

Tracking issue for the async-generator dstr host-free-FAIL cluster (files that
compile host-free under `--target standalone` but fail at runtime). Filed so the
non-#3244 roots and the two measurement artifacts are not lost.

## Root decomposition (verified against origin/main @ 503b64ac35, 2026-07-13)

An in-process batch scan of all 558 async-generator dstr files reported ~85
host-free fails; classified by TRUE root (each verified by instrumenting the
actual wrapped source + cold isolated repros — the per-assert line labels are
unreliable, see Artifact A):

| Root | ~files | Owner / disposition |
| --- | --- | --- |
| **any-boxed reference-element read** (#3244) | bulk | **#3244** (dominant gate) |
| **any-strict-eq object identity** (`notSameValue`) | ~30 | opus-genproto3 (ref.eq object `===`, extends #2734) |
| error-path throws (ReferenceError / TypeError) | ~29 | **MIRAGE — see below** |
| `__array_from_iter_n` over-pull / IteratorClose | small | this issue (genuine, isolation-resistant) |
| object-rest `{...rest}` exclusion | ~9 | this issue (verify vs #3244) |

## The error-path "root #2" is a MIRAGE (29 files)

The error-raising MECHANISMS work — do NOT build an "error-machinery" slice
from this bucket:

- **Unresolvable-default → ReferenceError**: `[ x = unresolvableReference ] = []`
  / `{ x: y = unresolvableReference }` — the PURE error-path test files
  (`obj-ptrn-prop-id-init-unresolvable`, `dflt-ary-ptrn-elem-id-init-unresolvable`,
  `ary-ptrn-elem-id-init-unresolvable`, expr variants) **PASS cold on both
  lanes**. Isolated probe of unbound-name read + `typeof` unbound + renamed-bind
  read-original all raise ReferenceError correctly (`.tmp/referr.mts`).
- **Poisoned-iterator/getter → TypeError**: `dflt-ary-init-iter-get-err`,
  `ary-init-iter-get-err`, `ary-ptrn-elem-id-iter-step-err`,
  `obj-ptrn-prop-eval-err` — **PASS cold**.

Files bucketed here (because their SOURCE contains an `assert.throws(...)` probe)
actually fail on a preceding **binding-value** assert rooted in **#3244**. E.g.
`obj-ptrn-prop-obj-init.js` (`async function* f({ w: { x, y, z } = {x:4,y:5,z:6} })`,
called `f({ w: undefined })`) — instrumented cold, `x` reads back WRONG (not 4):
the nested-object default binds through an any-boxed param → #3244. The
ReferenceError probe in the same file never gets to matter. **⇒ Root #2 collapses
into #3244; no independent error-machinery bug here.**

## Genuine, non-#3244 residuals (this issue owns)

1. **`__array_from_iter_n` over-pull for a param pattern over a custom
   iterator** — `async function* f([x]) {}` called with a never-`done` custom
   iterator (`ary-init-iter-close.js`) traps "requested new array is too large
   in `__array_from_iter_n`" instead of pulling 1 + IteratorClose (`return()`).
   NOTE: the simplified local `const [x,y] = iter` and a plain-param `f([x])`
   over an *incrementing* infinite iterator both work cold — this repro is
   **isolation-resistant** (only the async-gen frame + the specific
   `{value:null,done:false}` iterator triggers it). Needs in-frame diagnosis.
2. **object-rest `{a, b, ...rest}`** — `assert.sameValue(rest.a, undefined)`
   fails (`obj-ptrn-rest-val-obj.js`, `dflt-obj-ptrn-rest-val-obj.js`). Verify
   whether genuine rest-exclusion or #3244-adjacent (rest object built over an
   any-boxed source).

## Artifact A — unreliable per-assert line labels

The runner maps a failing `test()` return value (the assert counter) back to a
source line by text search. Async microtask reordering shifts the
assert-count→line mapping, so labels like "assert #6 notSameValue" routinely
mislabel the true failing assert. **Always instrument the actual wrapped source
(bitmask per assert) — never trust the label.** (This is how the 30 `notSameValue`
files were shown to fail on any-eq, not rest-binding.)

## Artifact B — in-process runner warm/cold order-dependence

The same file, same target, gives different pass/fail depending on run ORDER in
one process: `obj-ptrn-prop-obj-init.js` **PASSES** when run after other async
files, **FAILS** cold (first / fresh process, deterministic across 3 runs).
Running other async tests first "warms up" state that spuriously flips a
genuinely-failing file to pass ⇒ **batch in-process scans UNDER-count fails**.
Cold isolated per-file runs are authoritative. Root not yet identified (compiler
program/checker cache affecting later-file codegen? shared microtask/scheduler
state on the host side?). Worth a runner-hygiene fix so async floor measurements
are order-independent.

## Disposition

The async-gen dstr host-free-fail floor gain is **gated on #3244** (dominant) +
genproto3 (any-eq). The residuals above are minor levers. Recommend landing
#3244 first, then re-measuring the cluster cold before touching residuals.

## Repros

`/workspace/.claude/worktrees/*/.tmp/`: `referr.mts`, `cold.mts`,
`statebleed.mts`, `bitmask3.mts`, `iterpull.mts`, `parampull.mts`,
`classify.mts`.
