---
id: 3251
title: "standalone: array-descriptor OVERLAY substrate — $Vec receivers have no per-index/expando property-descriptor storage (blocks array-exotic defineProperty + Array generic-method-over-accessor-index)"
status: needs_architect_spec
sprint: Backlog
created: 2026-07-13
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: epic
area: codegen, runtime, standalone
language_feature: arrays, property-descriptors
goal: standalone-mode
umbrella: 1781
related: [3246, 2042, 2992, 3116, 2668]
horizon: xl
epic: true
---

# #3251 — array-descriptor OVERLAY substrate (standalone)

**This is an ARCHITECT EPIC, not a dev slice.** Cross-cutting, real
standalone-floor regression risk. Needs an implementation spec before any
code. Filed after a scope-first investigation of the #3246 array-exotic
defineProperty follow-up proved the slice is substrate-blocked (see root cause).

## Problem

Under `--target standalone`, WasmGC-vec-backed arrays (`$Vec`) have **no
per-index or expando property-descriptor storage**. Every array-property
operation that needs descriptor semantics (attributes, accessor get/set,
ValidateAndApplyPropertyDescriptor redefine-legality, non-configurable/
non-writable enforcement) is silently dropped or bypassed. Both the **write**
side (`Object.defineProperty(arr, idx/name, desc)`) and the **read** side
(`arr[idx]`, `Object.getOwnPropertyDescriptor(arr, k)`, iteration through a
defined accessor index) are incoherent with each other.

## Root cause (verified 2026-07-13, opus-defineprop2)

Verified with a local standalone test262 runner (compile → `_start` →
render exn) + WAT dumps:

1. **`__defineProperty_value` native lenient no-op on `$Vec`**
   (`src/codegen/object-runtime.ts:5135`): the body opens with
   `any.convert_extern; ref.test $Object; i32.eqz; if → return obj`. Array
   receivers are `$Vec`, **not** `$Object`, so they hit the early return —
   **zero** ValidateAndApply validation and **zero** coherent descriptor
   storage for array-INDEX defines. (The #2042-S4 preflight lives *inside*
   this native, after the `$Object` gate, so it never runs for arrays.)

2. **Named-key define on arrays works only via COMPILE-TIME machinery, not a
   runtime overlay** (`src/codegen/declarations.ts:2570` `widenedTypeProperties`
   + `definedPropertyFlags` + `emitStaticDescriptorTransitionThrow`): when the
   compiler statically sees `arr.foo` referenced, it widens the var to a struct
   with a `foo` field and validates redefine transitions at compile time. That
   is why `Object.defineProperty(arr,"foo",{...configurable:false})` +
   config-flip redefine throws (15.2.3.6-4-34 passes). Array **indices**
   (`"0"`,`"1"`) are vec *elements*, never widened struct fields, so they miss
   this path entirely — no field, no flag tracking, no throw.

3. **Plain-object index-key redefine already validates** (S4 works on
   `$Object`) — confirming the gap is array-specific: `$Vec` receivers bypass S4.

4. **`verifyProperty` demands full read/write coherence**
   (`test262/harness/propertyHelper.js:86`): it asserts
   `desc.value === obj[name]` via a DIRECT index read, plus writability probes
   that WRITE `obj[name]` and check it stuck, plus enumerability/configurability
   (for-in + delete) probes. So making a redefine *throw* is necessary but NOT
   sufficient — element reads AND writes must honor per-index descriptor
   attributes. That is the substrate this epic must build.

## Impact (why this is a big lever, not a 69-test slice)

Two host-free-FAIL clusters are downstream of the SAME missing substrate:

- **Array-exotic defineProperty TypeError cluster** — 69 `built-ins/Object/
  defineProperty` "'O' is an Array" tests; 41 use `verifyProperty` (need full
  coherence), 28 throw-only (many need per-index configurability for
  length-shrink). The self-contained cases (length attr/accessor TypeErrors
  9/10, named-key redefine -34/-187/-188) already pass.
- **Array generic-method over a defined-accessor index** — **~204 host-free
  assertion_fail** (`built-ins/Array/prototype/{map,filter,reduce,reduceRight,
  forEach,some,every}` `15.4.4.*`, signature `assert(testResult, 'testResult
  !== true')` + `assert(accessed,...)`, plus ~43 `newArr.length`). These do
  `Object.defineProperty(arr, "1", { get() {...} })` then iterate; the getter
  is never stored/consulted during iteration, so the callback never sees the
  accessor value. Same root: no per-index accessor-descriptor storage on `$Vec`.
  (opus-crashes independently observed array/function EXPANDO writes returning
  NaN — same substrate; that symptom belongs here.)

Total addressable ≈ **250–300 host-free-FAIL** once the overlay is coherent.

## Proposed direction (for the architect to spec)

Give a `$Vec` receiver a **companion per-index/expando descriptor map** that
ALL of these consult uniformly:
- `Object.defineProperty` (index + name) — store value + attributes, run the
  full §10.1.6.3 ValidateAndApplyPropertyDescriptor (reuse the
  `__defineProperty_value` S4 preflight) against the companion.
- element **read** (`arr[k]`) — an index carrying a non-default descriptor
  (accessor, or non-writable value) reads through the companion; plain dense
  elements keep the fast vec path.
- element **write** (`arr[k] = v`) — honor per-index `writable:false` (drop) +
  accessor `set`.
- `Object.getOwnPropertyDescriptor` / `getOwnPropertyNames` / for-in — merge
  the companion with the dense vec elements.
- array-`length` ArraySetLength (§10.4.2.1) with per-index non-configurable
  shrink-blocking (the 28 throw-only length tests).

Key design questions for the spec:
- **Storage**: a side `$Object` companion keyed by vec identity (ref.eq scan vs
  a hidden field on `$Vec`); the vec type layout is load-bearing across every
  array op, so a hidden field is a large blast radius — weigh vs a side table.
- **Fast-path preservation**: dense arrays with no defined descriptors must
  keep the zero-overhead `array.get`/`array.set` path (perf + no regression).
  Gate the companion consultation on "this vec has ≥1 special descriptor."
- **Host lane byte-identical**: all changes `ctx.standalone`-gated; host routes
  through `__defineProperty_desc` / `__vec_set_elem` (#3116) imports already.

## Acceptance criteria (epic-level; slice in the spec)

- Array-index `Object.defineProperty` stores value + attributes coherently;
  `arr[idx]` and `getOwnPropertyDescriptor(arr, idx)` agree.
- ValidateAndApplyPropertyDescriptor redefine-legality throws catchable
  TypeError for arrays (non-configurable redefine, non-writable value change,
  data↔accessor flip, etc.).
- `verifyProperty` passes for array-index defines (full read/write/enumerate/
  configure coherence).
- Array generic methods visit a defineProperty'd accessor index and invoke its
  getter (the ~204 `testResult`/`accessed` cluster).
- Dense-array fast path unchanged (no perf/behaviour regression); host/gc
  output byte-identical; standalone floor NET ≥ 0.

## Provenance

Filed from the #3246 follow-up scope-first analysis (tech-lead-directed). The
compile-time-`definedPropertyFlags`-for-indices interim was explicitly declined
(flips only the few index throw-only tests that don't read back — not worth the
complexity). This epic is the correct-sized fix.
