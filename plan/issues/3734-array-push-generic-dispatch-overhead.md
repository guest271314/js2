---
id: 3734
title: "array.ts landing-page benchmark: IR compiles .push() to a non-inlined helper call while legacy fully inlines it — same IR-vs-legacy gap as #3739/#3741, not a generic-dispatch problem"
status: ready
sprint: Backlog
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: arrays
goal: performance
depends_on: []
related: [3704, 3733, 3739, 3741]
---
# #3734 — `array.ts` push loop: IR emits a non-inlined helper call, legacy fully inlines

## Context

Discovered while investigating why the landing-page playground benchmark
(`website/playground/examples/benchmarks/array.ts`) shows wasm running
noticeably slower than JS. The benchmark is:

```ts
export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}
```

## Original diagnosis (below) was based on the wrong code path — corrected 2026-07-28

The original write-up (kept below for the record) inspected `.wat` output
and concluded `.push()` on a statically-typed `number[]` was routing through
the generic, `any`-receiver `__vec_push` dispatcher (externref-boxing +
`ref.test` chain, `src/codegen/expressions/call-receiver-method.ts` lines
~3298-3406, the "#2784 S3 Native-vec-aware method dispatch" block). **That
block only fires for `any`/externref receivers whose concrete vec type is
NOT statically known** (its own comment: "a reconstructed-fnctor `T[]` field
read as externref"). `arr: number[]` in the benchmark has a statically known
type, so it **never reaches that dispatcher at all** — the original
diagnosis inspected the wrong branch.

### What's actually happening

Direct investigation (compiling the exact benchmark source and comparing
`experimentalIR: false` vs the default IR path — the same method used for
#3739/#3741) found this is **the same "IR path lacks legacy's optimization"
gap already documented in #3741**, just showing up on `.push()`/array
codegen instead of ToInt32/loop-counters:

- **Legacy already has a fully monomorphic, fully-inlined push fast path**:
  `compileArrayPush` in `src/codegen/array-methods.ts` (line 2938) — direct
  `struct.get`/`array.len`/`array.new_default`+`array.copy` (amortized
  growth)/`array.set`/`struct.set`, zero externref boxing, zero `ref.test`,
  and (being emitted inline into the caller's body, not a separate function)
  zero call overhead.
- **IR lowers `.push()` to a call into a separate, shared helper function**
  instead: `src/ir/from-ast.ts` (~line 5037, the "#2856 element-store
  helper" comment) emits `cx.builder.emitCall(irIntrinsicFuncRef("__vec_elem_set_<N>"), [recv, lenI32, val], null)`
  — reusing the SAME helper plain `arr[i] = v` index-assignment uses. The
  helper's body (materialized elsewhere) is structurally almost identical to
  legacy's inline sequence (same growth-check/`array.new_default`/`array.copy`
  shape) — but it's a genuine `call`, once per `.push()`, 10,000 times in
  this benchmark, not inlined into the loop body.
- Measured directly (same source, `-O4` applied both ways, matching the real
  benchmark's settings): **legacy ~95-140µs, tight; IR ~225-450µs and
  visibly noisy (some runs spike to 1000-1400µs)**. The noise pattern mirrors
  the V8-tiering instability documented for `loop.ts` in #3739 — not just
  raw instruction-count overhead.

### An experiment that only partially worked (not landed)

Tried the cheap, low-risk fix first: raise Binaryen's inlining thresholds
(`setFlexibleInlineMaxSize`/`setOneCallerInlineMaxSize`/`setAlwaysInlineMaxSize`)
so `wasm-opt -O4` inlines `__vec_elem_set_<N>` automatically at its (many)
call sites, no compiler source changes needed. This is safe in principle
(inlining is semantics-preserving) and would have been a very contained fix
if it had fully worked. It only helped partially — IR's measured time
dropped to ~225-500µs but the gap to legacy and the run-to-run noise both
persisted — meaning the overhead isn't purely "missing inlining"; something
about the call-boundary/value-shape itself (plausibly the same f64⇄i32
conversion-at-boundary pattern #3739/#3741 found, or the same tiering
sensitivity) is also in play. Not committed — reverted after the experiment.

### Point 2 from the original write-up (loop-invariant `arr.length` read) is unaffected by this correction

That observation (the sum loop's `for (i = 0; i < arr.length; i++)`
re-reading the length field every iteration instead of being hoisted) is
still accurate and still low-priority/optional — untouched by this
correction, kept for completeness.

## Recommendation

Don't treat this as an isolated "add a monomorphic push fast path" fix — the
generic dispatcher it originally blamed isn't involved. This is the same
underlying architecture gap as #3741 (IR systematically re-derives, via
non-inlined shared helpers and f64-default representations, work legacy
already does inline/natively) manifesting on `.push()`/array codegen.
Whoever picks this up should read #3741 first — the two are almost
certainly best solved together (or by the same underlying mechanism,
whatever that turns out to be), not as separate one-off patches per
benchmark.

---

## Original write-up (2026-07-28, before the above correction)

Compiled (`-O`, JS-host/GC target) and inspected the `.wat`. Two separate
observations, in order of suspected impact:

### 1. `arr.push(i)` calls the generic, polymorphic `__vec_push` helper

Every `.push()` call site compiles to a call into a single shared
`__vec_push(externref, externref) -> i32` runtime function (see
`src/codegen/array-methods.ts`) that:

1. Boxes the receiver to `externref` (`any.convert_extern`).
2. Runtime-dispatches which concrete vec struct type it is via a
   `ref.test`/`ref.cast` chain (checked at least 3 candidate struct type
   indices in the disassembly — presumably one per distinct element
   representation the module uses).
3. Only THEN does the actual amortized-doubling array-growth logic
   (`array.len` vs length field, conditional `array.new_default` + `array.copy`
   when capacity is exhausted, `array.set`, length-field bump) for whichever
   branch matched.

**(Corrected above: this generic dispatcher does not apply to a
statically-typed `number[]` receiver — this description is accurate for the
`any`-receiver case only.)**

### 2. The sum loop re-reads `arr.length` (a `struct.get`) every iteration

```
for (let i = 0; i < arr.length; i++) total = total + arr[i];
```

compiles to a `struct.get 4 0` (the length field) on every loop
iteration instead of being loop-invariant-hoisted once before the loop, even
though nothing in the loop body can change `arr`'s length. This is a single
cheap instruction per iteration (not a call), so likely much smaller impact
than #1 — flagged for completeness, lower priority than the push dispatch.

## Acceptance criteria

- [ ] Read #3741 first — this is very likely the same root cause / same fix.
- [ ] `array.ts`'s IR-compiled `.push()` loop matches (or comes close to)
      legacy's speed for the same source, under the same `-O4` settings the
      real landing-page benchmark uses.
- [ ] Equivalence tests pass, including polymorphic/`any`-typed array push
      call sites and the existing #2856 element-store IR tests (must still
      work — any fix here must not regress the shared `__vec_elem_set_<N>`
      helper's other caller, plain `arr[i] = v`).
- [ ] Re-run the playground benchmark generator and confirm `array.ts`'s
      wasm time improves materially and stops being noisy (check std-dev,
      not just mean — the noise itself is diagnostic).

## Out of scope

- This issue is analysis, not a landed fix — regression-risky enough
  (touches IR call-lowering / shared helper emission) that it should get
  its own dedicated implementation + review pass, very likely combined with
  #3741 rather than attempted separately.
