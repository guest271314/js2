---
id: 2379
title: "standalone: typed-vec array method on an externref receiver (top-level new Array(N)) emits invalid ref.cast"
status: in-progress
assignee: ttraenkler/sendev-receiver
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays, array-methods
goal: standalone-mode
related: [2190, 2191]
---

# #2379 — array method on an externref receiver emits invalid `ref.cast`

## Problem (file-verified, current main)

A **top-level** `new Array(N).sort()` (and the other typed-vec array methods)
emits **invalid Wasm**:
`CompileError: Invalid types for ref.cast: ref.as_non_null of (ref extern) has to
be in the same reference type hierarchy as (ref N)` in `__module_init`.

Isolated minimal repro (current main):
- `new Array(2)` alone → PASS
- `new Array(1,2,3).sort()` → PASS (element-list ctor → typed vec)
- `[3,1,2].sort()` → PASS (literal → typed vec)
- `new Array(2).sort()` at **module top level** → **THROW** (invalid cast)
- `export function test(){ new Array(2).sort() }` → PASS (function-body codegen
  dodges it — DO NOT use a fn wrapper to repro; the test262 files run at top level)

Measured: `built-ins/Array/prototype/sort` 14 pass / 32 fail / 8 CE. The
invalid-Wasm subset (~16-21 of the fails: the CompileError + null-deref buckets)
is this bug. (The 9 "Cannot convert object to primitive" fails are #1917
ToPrimitive-engine-gated — out of scope.)

## Root cause (pinned)

The array-method dispatch (`compileArrayMethod`, `src/codegen/array-methods.ts`)
probe-compiles the receiver to find its real type (lines ~2654-2698). For a
top-level `new Array(N)`, the probe returns **externref** (line ~2667), which
sets `receiverIsExternref = true` but does **NOT** update `vecTypeIdx` — so it
stays the default inferred vec type.

`compileArraySort` (line ~7064) then does
`compileExpression(propAccess.expression)` (→ pushes an externref) followed by
`struct.get { typeIdx: vecTypeIdx, fieldIdx: 0 }` — a `struct.get` on the typed
vec applied to an externref value → the invalid `ref.cast`/`ref.as_non_null` of
`(ref extern)` against the vec struct type.

`receiverIsExternref` IS computed at the dispatch level but is **not consulted by
the `case "sort":` arm** (line ~2796) nor threaded into `compileArraySort` — so
sort takes the typed-vec path unconditionally even when the receiver is an
externref carrier.

## Fix

When the receiver is an externref (`receiverIsExternref`), the typed-vec array
methods must NOT take the static-vec `struct.get`/`ref.cast` path. Gate the
`case "sort":` (and the other typed-vec methods that don't already check the
flag) on `!receiverIsExternref`, returning `undefined` so the dispatch falls
through to the generic/host-import fallback (the same path `join` uses for an
externref receiver). This produces VALID Wasm and the runtime path handles the
externref array correctly.

Bonus (guardrail #3): the same `struct.get vecTypeIdx` on an externref receiver
affects every typed-vec array method (filter/map/reduce/forEach/find/…). Audit
the dispatch arms — any that route to a `compileArray*` helper without an
`!receiverIsExternref` gate share this invalid-cast bug on a top-level
`new Array(N).<method>`; gating them all flips more for free. Measure.

## Acceptance criteria

1. Top-level `new Array(2).sort()` compiles to VALID Wasm (instantiates) standalone.
2. `built-ins/Array/prototype/sort` invalid-Wasm subset flips (re-measure;
   exclude the 9 #1917 ToPrimitive fails).
3. No regression: `new Array(1,2,3).sort()`, `[3,1,2].sort()`, comparator sort,
   and the existing typed-vec array-method fast paths stay correct (WAT-diff a
   literal-array sort; broad equivalence; HW floor).
