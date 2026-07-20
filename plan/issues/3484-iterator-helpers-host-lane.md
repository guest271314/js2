---
id: 3484
title: "Iterator Helpers (host lane): Iterator global + Iterator.prototype.{map,filter,take,drop,flatMap,reduce,find,some,every,forEach,toArray} — ~84 host fails"
status: ready
created: 2026-07-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
goal: test262-conformance
model: opus
sprint: current
horizon: xl
related: [2903]
---

# #3484 — Iterator Helpers for the host lane

Implement the TC39 Iterator Helpers proposal (`%Iterator.prototype%.{map, filter,
take, drop, flatMap, reduce, find, some, every, forEach, toArray}` + the `Iterator`
global) for the **JS-host lane**. ~84 host-lane test262 fails
(`built-ins/Iterator/prototype/**`) currently report `X is not a function` and a
handful of value mismatches.

## Current state (verified 2026-07-20 while triaging)
- **The native helpers already exist — but STANDALONE ONLY.** `iter-lazy-native.ts`
  (`LAZY_ITER_METHODS = {map, filter, take, drop, flatMap}`) and `iter-hof-native.ts`
  (`NATIVE_ITER_HOF_METHODS = {find, every, some, forEach, reduce, toArray}`) emit
  WasmGC helper constructors via `closed-method-dispatch.ts`, gated on
  `ctx.standalone` (closed-method-dispatch.ts:243/253). In HOST mode `iter.take(n)`
  routes through `__extern_method_call`, which cannot drive a WasmGC iterator →
  silently `undefined`.
- **The `Iterator` global is not defined in either lane.** A bare `Iterator`
  identifier falls to the "unimplemented global" null-externref fallback
  (`expressions/identifiers.ts:1221`).
- **Host-reflection shortcut does NOT work (ruled out).** Exposing bare `Iterator`
  as `__extern_get(__get_globalThis(), "Iterator")` so `Iterator.prototype.take.call(x)`
  uses Node's native (spec-compliant) helpers FAILS: our iterators AND plain objects
  are WasmGC/`$Object` values the host's `Iterator.prototype.take` can't drive via
  `.call` (probe: `[].values()` → yields 0; `{next(){…}}` → "undefined is not a
  function"). So the helpers must be implemented natively in-compiler for the host
  lane too — not delegated to the host.

## Failure shape
Tests use BOTH forms:
1. Method-call: `iter.map(f).take(n).toArray()` (host-lane: currently `undefined`).
2. First-class + generic: `Iterator.prototype.take.call(genericObj, limit)` where
   `genericObj` is any object with a `.next` method (GetIteratorDirect). Requires a
   real `Iterator.prototype.take` function value + generic applicability.
Method frequency in the 84: flatMap 12, every 9, some 9, take 8, find 8, reduce 8,
map 6, forEach 6, filter 5, drop 2, toArray 1 (+ ~10 semantic/edge).

## Implementation plan (multi-PR; take L/XL, land coherent slices)

**Slice 1 — extend the existing native helpers to the HOST lane.** Un-gate
`NATIVE_ITER_HOF_METHODS` / `LAZY_ITER_METHODS` from `ctx.standalone` in
`closed-method-dispatch.ts` and make the WasmGC helper structs + GetIterator ladder
work when the receiver is a `$Object`/externref (host lane). This flips the
method-call-form tests (`x.map().take().toArray()`). Verify no host regression (the
methods previously no-op'd to `undefined`; ensure the native path now wins the
dispatch for iterator receivers without breaking Array/vec `.map`).

**Slice 2 — the `Iterator` global + `%Iterator.prototype%`.** Define `Iterator`
(abstract constructor: `new Iterator()` throws TypeError; `Iterator.prototype` is a
real object) and expose the helper methods as own properties of `Iterator.prototype`
as first-class function values (so `Iterator.prototype.take` is a function). Route a
bare `Iterator` identifier (host lane, unshadowed, not a user class) in
`identifiers.ts` before the null fallback.

**Slice 3 — generic applicability (`.call`).** `Iterator.prototype.take.call(obj, n)`
must apply to any object with `.next` (GetIteratorDirect, §27.1.4.x): the helper
reads `obj.next`, builds a helper-iterator that pulls from it. Plus spec edges:
RangeError on negative/NaN limit for take/drop (currently clamped, per
iter-lazy-native boundaries), IteratorClose on early return, `return`-method
propagation, helper-iterator `[Symbol.iterator]`/brand.

## Acceptance
- `built-ins/Iterator/prototype/{map,filter,take,drop,flatMap,reduce,find,some,every,
  forEach,toArray}/**` host-lane pass (target the ~84 fails; Slice 1 alone should
  flip the method-call-form majority).
- Standalone lane unchanged (already green via the native path).
- Zero regression on Array/vec `.map`/`.filter`/`.reduce` (which must keep eager
  semantics, not lazy iterator wrappers).

## Notes for the implementer
- Reuse `ensureNativeIterHof` / `ensureNativeLazyIter` — the stepper logic is done;
  the work is host-lane wiring + the `Iterator` global/prototype + generic `.call`.
- `#2903` (R3) is the standalone origin; this issue is its host-lane completion.
- Budget-fit: this is an XL big-rock — start early in a budget window.
