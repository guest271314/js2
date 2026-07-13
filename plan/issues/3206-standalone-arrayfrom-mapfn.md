---
id: 3206
title: "Standalone: Array.from(source, mapFn) leaks __make_callback + __array_from — the last harness-level gate before the makeCtorArg TypedArray family"
status: in-progress
assignee: ttraenkler/opus-arrayfrom
created: 2026-07-13
updated: 2026-07-13
priority: high
task_type: bug
area: codegen, runtime
language_feature: array-from
goal: standalone
sprint: current
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

- [ ] `Array.from([5,6,7], v=>v*2)` standalone: host-free, instantiates, correct.
- [ ] `Array.from({length:3}, (_,i)=>i)` standalone: host-free, instantiates, correct.
- [ ] Identifier-held mapFn `Array.from(x, f)` host-free.
- [ ] Measured fail→pass flips on `built-ins/Array/from` + the makeCtorArg
      `built-ins/TypedArray/prototype/**` family (process-isolated, branch vs main).
- [ ] Zero host-mode / gc / wasi regression; unrelated modules byte-identical.
