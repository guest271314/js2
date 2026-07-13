---
id: 3146
title: "standalone: Iterator.zip / zipKeyed / concat / from (~99 __get_builtin CEs)"
status: done
completed: 2026-07-12
assignee: ttraenkler/fable-dev-3146
sprint: 71
priority: high
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2984]
# LOC-budget gate (#3102): intentional growth from the shared-substrate ladder
# extensions (GC-ref carriers, string arm, OBJ next-fallback, optional deps),
# the __j2w_iter_* recognizer, and the source-prelude injection wiring. The bulk
# of the feature lives in the NEW src/iterator-statics-prelude.ts (not ratcheted).
loc-budget-allow:
  - src/codegen/iterator-native.ts
  - src/codegen/expressions/calls.ts
  - src/compiler.ts
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
---

# #3146 — standalone Iterator static helpers (zip / zipKeyed / concat / from)

## Problem

The ES2025 Iterator static helpers `Iterator.zip`, `Iterator.zipKeyed`,
`Iterator.concat`, `Iterator.from` used standalone hard-CE through the
`__get_builtin` dynamic-shape refusal (#1472 Phase B). Measured **99** non-pass
standalone entries under `built-ins/Iterator/{zip,zipKeyed,concat,from}/`. This
is the largest single in-scope builtin-CALL-surface bucket in the #2984
`__get_builtin` triage.

## Sample paths

- `test/built-ins/Iterator/zip/iterator-zip-iteration-shortest-iterator-close-abrupt-completion.js`
- `test/built-ins/Iterator/zipKeyed/iterator-zip-iteration-strict-iterator-close-i-is-zero-abrupt-completion.js`
- `test/built-ins/Iterator/concat/return-is-forwarded.js`
- `test/built-ins/Iterator/concat/return-is-not-forwarded-after-exhaustion.js`

## Shared-infra deps

- Needs the standalone iterator-protocol substrate (open-object iterator
  result reads, `.next()`/`.return()` forwarding, abrupt-completion
  iterator-close). Much of the corpus exercises iterator-close ordering on
  abrupt completions — the hard part is the protocol plumbing, not the
  namespace recognizer. Likely wants an architect spec first (feasibility:
  hard). Consider splitting `from` (simplest — wraps an iterable) from
  `zip/zipKeyed/concat` (multi-source close semantics).

## Acceptance

- `built-ins/Iterator/{zip,zipKeyed,concat,from}/*` standalone tests compile +
  pass with 0 regressions on a passing-test sweep. May land as sub-slices per
  helper.

## Implementation (2026-07-12, fable-5)

Approach: **source-prelude injection** (the #2632 `process.stdin` /
#1501 timer-shim model), NOT hand-emitted `Instr[]`. The four helpers are
written as ordinary TypeScript in `src/iterator-statics-prelude.ts`, prepended
after any directive prologue, and `Iterator.<helper>` references are rewritten
to `__js2wasm_Iterator_<helper>`. The prelude drives every source iterable
through the **native iterator runtime** (`iterator-native.ts`) via four new
`__j2w_iter_*` intrinsics (recognizer in `expressions/calls.ts`), so it inherits
the full GetIterator ladder + `.return()`-forwarding IteratorClose with **zero
new host imports**. Injection is import-scoped + host-free-target-only (JS-host
keeps the #1464 runtime.ts polyfills).

Key native-runtime extensions (`iterator-native.ts`, all strictly additive on
previously-trapping paths):

- `collectVecFamilyCarriers` now admits **GC-ref-element vecs** (nested array
  literals `[[..],[..]]`) via identity `extern.convert_any` — fixes the dynamic
  array-of-arrays GetIterator `illegal cast`.
- A **STRING arm** normalizes a string subject into its char vec
  (`__str_to_char_vec`) — `Iterator.from("ab")`.
- The **OBJ arm** gains a truthy-`next`-property fallback (a bare
  `{ next() {} }` plain object is its own iterator), and the **USER tail**
  re-tags an `$Object` iterator returned by `@@iterator` as OBJ kind.
- `UserCarrierDeps.callIteratorIdx` / `sgetValueIdx` / `sgetDoneIdx` are now
  **optional** — a module whose only iterator carriers are bare `{next}`
  literals (every zip test262 file) still gets a USER arm; the step arm reads
  the result carrier-branched (`$Object` → `__extern_get`, closed → `__sget_*`,
  neither → done=1).

Prelude dialect constraints (probed): mutable state lives in OBJECT FIELDS
(closure-captured local writes are lost on a callee's abrupt exit); result
iterators are OPEN objects with a post-hoc `res[Symbol.iterator]=` (a computed
`[Symbol.iterator]` literal key would pre-shape into a closed struct whose
name-keyed `__call_next`/`__call_return` dispatch collapses zip/concat/from onto
one shared body); iterators are chained via a linked `nxt` field, not a
closure-captured `any[]` (element reads of a captured `any[]` lose method
dispatch on this backend).

## Test Results (2026-07-12)

Scoped equivalence probes (`.tmp/probe-3146-e2e.mts`): 13/13 PASS — from(array/
custom/string), concat sequencing + return-forwarding, zip shortest/longest-
padding/strict, zipKeyed, reverse-close ordering, IteratorClose, TypeError on
non-iterable, `typeof Iterator.zip`.

Standalone test262 sweep of `built-ins/Iterator/{zip,zipKeyed,concat,from}`
(129 files, all `__get_builtin`-CE before this change): **28 pass** (host-free),
up from **0**. Remaining non-pass are separate pre-existing gaps, NOT regressions:

- `illegal cast` (~18): `Iterator.zip(Object.create(null))` etc. — a non-
  iterable object should throw a **catchable** TypeError, but the native
  `__iterator` GetIterator ladder's tail hard-cast-traps. Broader native-runtime
  fix (loud-trap tail → catchable TypeError), out of scope here.
- getter-backed `done`/`value` (~4, incl. the 2 that OOM a single-process sweep;
  CI runs each in a worker with a hard timeout → scored `fail`): standalone
  `__extern_get` does not invoke accessor getters (kin to #2046). **Not** an
  infinite-loop bug in the helper lowering — the loops are structurally bounded
  by `done`; adding an iteration cap would break legitimately-infinite iterators
  (which the concat/return tests rely on).
- `Reflect.get` with explicit receiver (#2046), BigInt extern-class,
  vacuous-harness — unrelated standalone gaps.

Existing standalone iterator regression suite (`tests/issue-1320-standalone`):
8 pass / 2 pre-existing fail (`arr.entries()` — fail identically with all my
`src/` changes stashed, i.e. NOT caused by this work).
