---
id: 3673
title: "perf: compiled acorn parses 1,400-3,000x slower than node-acorn — host-bridge hot-path costs"
status: in-progress
assignee: claude/acorn-performance
created: 2026-07-26
updated: 2026-07-26
loc-budget-allow:
  - src/runtime.ts
priority: high
feasibility: medium
reasoning_effort: high
task_type: perf
area: runtime, codegen
goal: self-hosting-dogfood
sprint: current
model: fable
related: [1712, 1946, 1947, 3669, 3671]
---

# #3673 — Horrible performance of compiled acorn

## Problem

With the #1712 dogfood milestone complete, compiled acorn is **correct**
(23/23 corpus exact, full test262 parser differential 53,259/53,259 files
exact) but catastrophically slow. Measured baseline (median, Node 22 V8,
`.tmp/bench-acorn.mjs`, cached binary, steady-state):

| input                        | node-acorn | compiled | slowdown |
| ---------------------------- | ---------- | -------- | -------- |
| literals.js (259B)           | 0.055ms    | 77.6ms   | 1,407x   |
| members-calls.js (213B)      | 0.050ms    | 107.1ms  | 2,135x   |
| control-flow.js (330B)       | 0.074ms    | 155.7ms  | 2,115x   |
| 17-file corpus concat (4.3KB)| 0.666ms    | 2,050ms  | 3,078x   |

AST marshalling (`wrapExports`) is NOT the cost — the raw export is equally
slow. Compile time is a separate axis: ~21-26s to compile acorn, 682KB
host-mode binary.

## Root-cause analysis (measured, V8 --cpu-prof + per-import counters)

A 330-byte parse makes **45,239 host-bridge crossings** (~137 per input
byte): `__box_number` 6.4k, `__extern_get` 5.3k, `__get_undefined` 4.7k,
`__unbox_number` 4.5k, `__typeof_number` 3.9k, `__is_truthy` 3.8k,
`__host_eq` 3.5k, `__host_compare` 3.5k, `__extern_get_raw_callable` 3k,
`__extern_method_call` 0.9k, `__extern_set_strict` 0.3k… This is the
consequence of fnctor instances resolving to externref (#1712 two-shape
fix): every field read/write, comparison, truthiness test and method call
on Parser/token state crosses to the JS host.

The crossings themselves (~0.1-0.3µs) were NOT the dominant cost. The
bridge's per-call implementation was:

1. **`_isWasmStruct` — 57.6% of total CPU.** It classified via a
   property-set probe on the receiver inside try/catch. For a WasmGC struct
   (the overwhelmingly common receiver) the probe **throws on every call**,
   and it allocated a fresh `Symbol` per call. Called several times per
   crossing across `_safeGet`/`_safeSet`/`__extern_get`.
2. **`_getStructFieldNames` filter — 28% of CPU after (1).** Answering
   "does this struct have own field `x`" enumerated the shape's CSV and
   called the `__shas_<field>` Wasm presence export for EVERY field of the
   shape (acorn's Parser struct has dozens) — dozens of Wasm re-entries per
   property read (the #2739b own-field shadow check runs per method read).
3. **`_safeSet` native write probe.** For struct receivers it attempted
   `obj[key] = val`, which on an opaque WasmGC object unconditionally
   throws in strict code — a guaranteed V8 exception per property write.
4. **`_resolveClassMemberOnInstance`** did a megamorphic dictionary-mode
   exports lookup (`__member_kind_<key>`, exports object has thousands of
   keys) per dynamic instance read.
5. **Per-call closure creation** in `snapshotVecMirrors` (runs on every
   `__extern_method_call`/`__call_function` crossing) and
   `_resolveHostField` — each closure creation also paying the transform's
   `__name` defineProperty under tsx.

## Fixes landed (this branch)

- `_isWasmStruct`: WeakSet verdict caches (classification is stable per
  object identity) + `Object.isExtensible` fast path (WasmGC objects report
  non-extensible; `Object.create(null)` is extensible — verified on Node 22).
  The probe-throw survives only for the rare non-extensible null-proto JS
  object, once per object.
- `_structFieldNamesRaw` + per-CSV split cache + `_structHasOwnFieldName`
  (single-key presence, one `__shas_` call); hot call sites converted
  (`_wasmStructHasOwn`, `_safeGet` #2739b shadow check, `_safeSet` #2731
  re-add check, `_readOwnDescriptor` data path, Object.assign/for-in
  helpers, marshal-shape probe).
- `_safeSet`: removed the always-throwing native write attempt for struct
  receivers (the `__sset_` writeback + sidecar are the real write lanes).
- `_resolveClassMemberOnInstance`: `__member_kind_<key>` verdict memoized
  per exports object (immutable after instantiation).
- `snapshotVecMirrors` inlined to a plain loop; `_resolveHostField`'s
  getter-invoke closure hoisted to a top-level helper.

## Measured after (same protocol)

| input                        | before   | after   | slowdown now |
| ---------------------------- | -------- | ------- | ------------ |
| literals.js (259B)           | 77.6ms   | 7.7ms   | 147x         |
| members-calls.js (213B)      | 107.1ms  | 8.9ms   | 234x         |
| control-flow.js (330B)       | 155.7ms  | 13.7ms  | 226x         |
| 17-file corpus concat (4.3KB)| 2,050ms  | 192ms   | 302x         |

**10.7x faster end-to-end; slowdown vs node-acorn reduced from ~3,000x to
~150-300x.** Gates: `dogfood:acorn-corpus` 23/23 exact (0 quirks, 0 real
gaps, incl. acorn self-parse), `tests/issue-1712.test.ts` acceptance green,
dynamic-dispatch/ifelse-global-shift/capture-closure/exactfield-lane pins
green. (`issue-1712-reflection-identity.test.ts` has 12 failures that
reproduce identically on the unmodified base — pre-existing container/env
issue, not from this branch.)

## Remaining follow-up (out of scope here, needs codegen)

The residual ~150-300x is dominated by crossing VOLUME, not per-call cost.
Structural reductions belong to the existing codegen goals:

- **#3669 / #3671 property-slot monomorphism** — keep hot fnctor field
  reads/writes on typed struct slots Wasm-side instead of `__extern_get`/
  `__extern_set_strict` crossings.
- **#1946/#1947 GC-ref typing / closure devirtualization** — reduce
  `__extern_get_raw_callable` + `__extern_method_call` dispatch.
- Cheap codegen wins observable in the .wat: `__get_undefined` is a host
  call per `undefined` literal use (4.7k/parse — cacheable in a global);
  `__typeof_number`/`__is_truthy`/`__host_eq`/`__host_compare` on boxed
  numbers could take a Wasm-side fast path before falling back to the host.
- Value representation (`__box_number`/`__unbox_number` 11k crossings per
  330B parse) is the #1584-era value-rep question.
