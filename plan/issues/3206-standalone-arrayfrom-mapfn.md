---
id: 3206
title: "Standalone: Array.from(source, mapFn) leaks __make_callback + __array_from — native map path"
status: done
completed: 2026-07-13
assignee: ttraenkler/opus-arrayfrom
created: 2026-07-13
updated: 2026-07-13
priority: high
task_type: bug
area: codegen, runtime
language_feature: array-from
goal: standalone
sprint: 71
horizon: m
related: [3140, 2169c, 2586, 2872, 2860, 3098]
umbrella: 2860
loc-budget-allow:
  - src/codegen/iterator-native.ts
  - src/codegen/expressions/calls.ts
origin: "2026-07-13 — banked intel in #3140: the makeCtorArg harness common prefix (harness/testTypedArray.js makeArray) uses Array.from({length:n}, fn) / Array.from(iterable, fn); the mapFn arm falls to the host __array_from + __make_callback bridge (unsatisfiable standalone → module fails to instantiate)."
---

## Problem

Under `--target standalone`, `Array.from(source, mapFn)` (2-arg, with a mapper)
falls through to the host fallback in `expressions/calls.ts` (the
`ensureLateImport("__array_from", …)` arm). That arm:

1. compiles the mapFn to externref via `compileExpression(…, {externref})`,
   which routes an inline arrow/function through `compileArrowAsCallback` →
   emits `call env.__make_callback` (the host closure bridge); and
2. calls the host import `env.__array_from(source, mapFn)`.

Both `env.__make_callback` and `env.__array_from` are unsatisfiable standalone,
so the module fails to instantiate.

Verified on main (2026-07-13):

- `Array.from([5,6,7], v => v*2)` → `env=[__make_callback, __array_from]`, instantiate FAIL.
- `Array.from({length:3}, (_,i) => i)` → `env=[__make_callback, __array_from]`, instantiate FAIL.
- 1-arg `Array.from([5,6,7])` is ALREADY host-free (the #2169c native drain), so
  the intel's "1-arg leaks __array_from" note is stale — only the mapFn arm remains.
- (Adjacent, out of scope here) 1-arg `Array.from({length:3})` array-like traps
  "illegal cast" — the 1-arg native drain hard-casts a `$Object` to `$Vec`. The
  2-arg mapFn fix below routes array-likes through `__extern_length`/`__extern_get_idx`
  so it is unaffected; the 1-arg array-like trap is a separate follow-up.

## Impact

The makeCtorArg harness common prefix (`harness/testTypedArray.js` `makeArray`)
is `Array.from({length:n}, fn)` / `Array.from(iterable, fn)`. This is the LAST
harness-level gate before the whole `built-ins/TypedArray/prototype/**`
makeCtorArg family can execute its bodies (with #2872 dynamic TA construction
and #3140 bind already landed).

## Fix — compose two existing native helpers (host-free)

`Array.from(source, mapFn, thisArg)` is semantically
`source.map(mapFn, thisArg)` after normalizing an iterable source to an
array-like carrier. Both pieces already exist native (my lane):

- `__array_from_iter_n(source, -1)` (`ensureNativeArrayFromIterN`,
  iterator-native.ts) — drains an iterable to a `$Vec`, passes indexable
  carriers (`$Vec`/`$ObjVec`/`$Object {length}`/host arrays) through UNCHANGED.
- `__hof_map(recv, cb, thisArg)` (`ensureNativeArrayHof(ctx,"map")`,
  hof-native.ts) — `__extern_length`+`__extern_get_idx` loop, invokes cb via
  `__apply_closure(cb, thisArg, [val, boxNum(i), recv])`, builds an `$ObjVec`.

New my-lane helper `ensureNativeArrayFromMapped(ctx)` builds
`__array_from_mapped(source, mapFn, thisArg) -> externref` =
`__hof_map(__array_from_iter_n(source, -1), mapFn, thisArg)`. `calls.ts` gets a
thin standalone-gated routing hook in the Array.from arm: compile source →
externref, mapFn → raw GC closure (`compileArrowAsClosure` for inline
arrow/function, else `compileExpression(…,{externref})` — the identifier-held
closure already crosses as a plain closure externref, mirrors the #3098 native
HOF gate at calls.ts:13699), thisArg → externref (or null), call the helper.

Arity/holes/thisArg semantics match `Array.from` (mapFn `(value, index)`;
`__apply_closure` clamps to declared arity so `map`'s extra `array` arg is
ignored; array-like holes read `undefined` via `__extern_get_idx`).

Standalone-gated only — gc/wasi/host stay byte-identical; the helpers are
registered on demand so unrelated modules are byte-inert (prove-emit-identity).

## Acceptance criteria

- [x] `Array.from([5,6,7], v=>v*2)` standalone: host-free (`env=[]`), test()=36.
- [x] `Array.from({length:3}, (_,i)=>i)` standalone: host-free, len 3 / 0,1,2.
- [x] Identifier-held mapFn `Array.from(x, f)` host-free, correct.
- [x] Measured fail→pass flips on `built-ins/Array/from` (process-isolated
      `runTest262File`, standalone lane, branch vs pristine-main@7bb01d2 control).
- [x] Zero host / gc / wasi regression; unrelated modules byte-identical.

## Test Results (2026-07-13, measured)

**Byte-identity** — `prove-emit-identity check` vs pristine-main baseline:
IDENTICAL across all 39 (file,target) emits (gc + standalone + wasi). The change
is standalone-gated and additive (the new helper is only reachable from the new
`ctx.standalone && args>=2 && !isNonArrayBuiltinCollection` branch, and
`ensureNativeArrayFromMapped(ctx)` is short-circuit-evaluated only under
`ctx.standalone`), so no non-standalone / non-mapFn module changes a byte.

**Conformance (standalone lane, `runTest262File(..., "standalone")`, branch vs
pristine-main@7bb01d2 control)** over `built-ins/Array/from` +
`built-ins/TypedArray/prototype/{fill,map,indexOf}` (158 files):

| | pass | fail | CE |
|---|---|---|---|
| pristine-main | 46 | 108 | 4 |
| branch | **52** | 102 | 4 |

**+6 real fail→pass flips, 0 regressions (0 pass→fail)** — all in
`built-ins/Array/from`, all mapFn-related, all non-vacuous:
`iter-map-fn-return`, `iter-map-fn-this-arg`, `iter-map-fn-this-non-strict`,
`iter-map-fn-this-strict`, `mapfn-throws-exception`, `elements-updated-after`.
The `this-arg` flips confirm `__hof_map`+`__apply_closure` bind the mapFn `this`
by identity (the tests assert `thisVals[i] === thisVal`).

**Honest scope note — the makeCtorArg TypedArray family did NOT flip.** None of
the `TypedArray/prototype/{fill,map,indexOf}` tests changed outcome. They now
fail one gate *further* than Array.from: `testWithTypedArrayConstructors`'s
harness callback is vacuous (`vacuous: harness-wrapper callback never executed
(#2940) — no assertion ran`). So `Array.from(source, mapFn)` was necessary
harness infrastructure but is NOT the final standalone gate for the makeCtorArg
family — the `testWithTypedArrayConstructors` callback drive is a separate
follow-up (the banked-intel expectation of "hundreds of TA tests unblock" is
optimistic; the direct measured yield here is the Array.from mapFn conformance
tests). Not counted as flips.

## Follow-ups

- `Array.from(Set|Map, mapFn)` standalone: excluded from the native branch (they
  are native collection structs `__array_from_iter_n` cannot drain → would read
  a wrong `__extern_length`). They keep the pre-existing (non-regressing) host
  fallback path. A native arm can route them through `emitCollectionIteratorVec`
  then `__hof_map`.
- mapFn `this` **property reads** (`this.k`) return a wrong value under
  standalone — a pre-existing `__apply_closure` this-binding gap shared with
  native `.map(fn, thisArg)` (identity binding works; property read does not).
  Not introduced here; belongs to the closure-dispatch lane.
- 1-arg `Array.from({length:n})` array-like traps "illegal cast" (the 1-arg
  native drain hard-casts a `$Object` to `$Vec`) — independent of this fix.
- `testWithTypedArrayConstructors` standalone harness-callback vacuity (#2940) —
  the actual next makeCtorArg gate.
