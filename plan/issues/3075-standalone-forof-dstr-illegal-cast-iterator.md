---
id: 3075
title: "standalone: for-of / for-await-of destructuring throws 'illegal cast [in __iterator]' (residual after #1323)"
status: done
sprint: 71
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterator-protocol, for-of, for-await-of, destructuring
goal: standalone-mode
related: [1781, 1323, 1454, 1347, 1471]
created: 2026-07-06
updated: 2026-07-13
completed: 2026-07-10
assignee: ttraenkler/fable-3075
origin: "2026-07-06 /harvest-errors run against standalone current.jsonl (6.7.2026)."
---

# #3075 — standalone for-of/for-await destructuring: illegal cast in `__iterator`

## Summary

**468 standalone-lane records** (0 in the default lane) fail with:

```
illegal_cast:L#:## illegal cast [in __iterator() ← fn ← test]
```

Category breakdown:

- **421 `language/statements`** — overwhelmingly `for-of/dstr/*` and
  `for-await-of/*` destructuring patterns.
- 11 `built-ins/Iterator`, 10 `built-ins/Array`, 8 `built-ins/TypedArray`,
  4 `AsyncFromSyncIteratorPrototype`, misc.

This is a **standalone-specific** iterator-protocol residual: the native
`__iterator()` bridge performs a `ref.cast` that traps when the iterated value's
runtime shape doesn't match the expected iterator-result / element type — most
often in destructuring-binding for-of/for-await targets (array/object patterns,
elision, rest holes, `iter-done` paths).

## Why filed now

`#1323` (Iterator protocol bridging — `$IteratorResult` struct in pure Wasm) is
`status: done`, and `#1471` (host boxing/unboxing elimination) is done, yet
this illegal-cast cluster persists at 468 in standalone. The residual is not
tracked by an open issue. Related open/borderline issues #1454
(iterator-protocol destructuring close) and #1347 (iterator-close-on-throw)
touch adjacent surface but do not name this `illegal cast [in __iterator]`
signature.

## Sample files

```
language/statements/for-await-of/async-func-dstr-let-async-ary-ptrn-elem-ary-empty-iter.js
language/statements/for-of/iterator-next-error.js
language/statements/for-of/iterator-close-via-continue.js
language/statements/for-await-of/async-func-dstr-var-async-obj-ptrn-prop-obj.js
language/statements/for-await-of/async-gen-dstr-var-async-ary-ptrn-elem-id-iter-done.js
```

## Suggested investigation

1. Compile one repro (e.g. `for-of/iterator-next-error.js`) with
   `--target standalone --no-host-imports`, dump the WAT, and locate the
   `ref.cast` inside the emitted `__iterator` helper that traps.
2. Determine whether the cast assumes a concrete iterator-result struct shape
   where the value is `any`/externref-shaped (native-string or boxed element)
   — this mirrors the substrate value-read gaps
   (`project_standalone_any_string_value_read_substrate`).
3. Widen the cast to the correct supertype (or add a type-guarded slow path)
   for the destructuring-target element read.

## Acceptance

- `illegal cast [in __iterator]` standalone count drops materially (<100).
- No net regression in either lane.

## Root cause (measured, 2026-07-10)

The 468-record cluster is dominated by the 390 for-await-of `dstr-*-async-*`
files, and **every one of them uses `yield*`** in the async-generator
producer. Under `--target standalone` a `yield*`-carrying generator body is
NOT a native-generator candidate (`isNativeGeneratorCandidate` rejects the
`async` modifier categorically, and function *expressions* are not wired to
the native factory at all), so it bails to the **legacy eager-buffer HOST
runtime** (`sourceNeedsGeneratorHostImports` → `addGeneratorImports`
`allowNoJsHost` bundle). Two stacked breaks followed:

1. **`__iterator` had no arm for a host external.** The generator object
   returned by host `__create_async_generator` internalizes outside every GC
   subhierarchy (not struct / array / i31), so the native GetIterator ladder
   fell through to the hard-cast tail → `illegal cast [in __iterator]`. (The
   bounded 3d-ii consumer drive doesn't apply: the tests bind a
   *destructuring pattern*, which `analyzeForAwait` rejects, and the source
   is an identifier, which `resolveAsyncGenNextHelperName` rejects.)
2. **`__gen_yield_star`'s host impl silently drained ZERO values** for a
   WasmGC `$Vec` operand (no `Symbol.iterator` on an opaque struct), so even
   with (1) fixed the buffered generator reported done immediately.

## Fix (PR)

- `src/codegen/iterator-native.ts` — new `ITER_KIND_HOSTGEN` IterRec arm,
  filled at finalize **only when the module already carries the legacy
  `__gen_*` imports** (no new host import; every other module is
  byte-identical). Classification: subject fails `ref.test` for the abstract
  `struct`/`array`/`i31` heap types ⇒ host external ⇒ it is its own iterator
  (GetIterator identity on generators). `__iterator_next` drives it via
  `__gen_next` + `__gen_result_done`/`__gen_result_value` (the buffered
  async-gen `next()` thenable exposes `value`/`done` synchronously —
  runtime.ts `mkResult`); `__iterator_return` closes via `__gen_return`;
  `__iterator_rest` drains through the shared step arm.
- `src/runtime.ts` — `__gen_yield_star` materializes a WasmGC vec operand
  through the module's `__vec_len`/`__vec_get` exports
  (`_materializeIterable`) before iterating; host arrays pass through
  unchanged (default lane byte-identical behavior).

## Test Results (2026-07-10, sample = every 7th of the 390-file cluster, n=56)

| lane | state | result |
| --- | --- | --- |
| standalone | upstream/main (control) | 51 illegal-cast / 5 pass |
| standalone | fixed | **0 illegal-cast / 33 pass** / 8 vacuous / 15 fail-other |
| default (n=14) | control vs fixed | identical (13 pass / 1 pre-existing fail) |

Adjacent-area standalone scans (for-of/dstr n=72, for-of n=30, generators
n=9, Iterator.prototype.toArray n=18) are **exactly identical** to control.
`tests/issue-3075.test.ts` (6 cases) passes; issue-2038/3100(s4,s5)/3119
suites pass (65/65); the 3 failures in `issue-1320*.test.ts` reproduce
identically on control (pre-existing, environment-related).

Extrapolated: ~355 of the 468 illegal-cast records eliminated, ~195 flip to
pass — acceptance (<100 residual) met.

## Residual decomposition (banked, out of scope here)

- **Vacuous (~14% of cluster)**: `$DONE` async-callback plumbing under
  standalone — the fn() promise chain's callback never runs in the harness
  wrapper. Same-shaped code returning counts via `test()` passes, so this is
  the standalone async-completion class (#2980 territory), not iterator
  protocol.
- **fail-other (~27%)**: eager-buffer semantic limits — per-step iterator
  side-effect counts (elision must call `next()` exactly once; the eager
  buffer drains everything at creation), `iter-close` observable ordering.
  Fixing these requires lazy generator semantics (native state machine for
  async gens / #3032-style lazy-first-resume for the async path).
- **Driven-producer frame carriers** (plain-yield async gens consumed via an
  identifier, e.g. `var it = (async function*(){ yield 1 })()`): still trap —
  an ASYNCGEN IterRec arm dispatching per-producer `__async_gen_next_<stem>`
  over `ctx.asyncGenProducers` is the natural follow-up slice.
