---
id: 1923
title: "architecture: retire the late-import function-index-shift bug class (always-on emit-time index validation + stale-proof func references)"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: refactor
area: codegen, emit
language_feature: compiler-internals
goal: standalone-mode
related: [1809, 1839, 1602, 1886, 1666, 1677, 1915, 1919]
origin: "2026-06-10 standalone gap review: the index-shift class has recurred ≥6 times (#1809, #1839, #1602, #1886, #1666, #1677) and is back again as #1915 (497 tests) — each fix was a point patch; this issue is the structural fix that ends the class."
---

# #1923 — Retire the late-import index-shift bug class structurally

## Problem

The single most-recurrent compiler bug class: a function/type/global index is
captured into a JS variable, a deferred late-import flush
(`flushLateImportShifts` / `addUnionImports` / `addStringImports`) shifts the
index space, and the captured value goes stale — or a failed `funcMap` lookup
bakes `-1`. Symptoms range from the opaque
`Binary emit error: u32 out of range: -1` to *silently valid-but-wrong*
indices that surface as random `expected externref, found i32` validator
failures on unrelated tests.

History of point fixes, each closing one instance and leaving the class open:

| Issue | Instance |
| --- | --- |
| #1809 | shift walker missed method-trampoline funcIdx pointing at an import |
| #1839 | `addStringImports` shift omitted `pendingInitBody` / `nativeStrHelpers` / `startFuncIdx` |
| #1602 / #1886 | earlier instances of the same capture-then-shift pattern |
| #1666 / #1677 | `--target wasi` native-helper func-index shifts (`__str_flatten` / `__str_to_extern`) |
| **#1915** | **current**: 497 standalone tests, `u32 out of range: -1` — and the env-gated `validateFuncRefs` guard does NOT catch it, so the poisoned index is outside the walked funcref locations (type/global/export/element) |

The pattern recurs because the design invites it: raw integer indices are
copied freely while the index space is still mutable, and nothing structurally
prevents a stale copy from reaching the encoder.

## Scope — the structural fix (architect-level decision)

Evaluate and ratify one (or a layered combination) of:

1. **Always-on, total emit-time validation.** Promote `validateFuncRefs`
   (`src/emit/binary.ts:105`, currently env-gated behind
   `JS2WASM_VALIDATE_FUNCREFS`) to always-on, and extend it from
   `call`/`return_call`/`ref.func` to **every index space the encoder writes**:
   type indices (`call_ref`/`struct.*`/`array.*`/block types/`ref null <t>`),
   global indices, table/element/export/start entries, and exception tags.
   Cost is a single linear walk per emit; it converts every future instance
   into a named, located codegen error at compile time (#1915 proves the
   current walker's coverage is insufficient).
2. **Stale-proof references.** Replace raw captured `funcIdx: number` with a
   handle that survives shifts — either (a) symbolic references (name or
   handle object) resolved to integers only inside `emitBinary`, after the
   last possible shift; or (b) a `FuncRef` cell object `{ idx }` that the
   shift walker updates in place, so every holder sees the shift. (a) is the
   clean fix; (b) is the incremental one that doesn't require touching every
   call site at once.
3. **Freeze-point discipline.** A module-level `indexSpaceFrozen` flag set
   after the final flush; any `ensureLateImport`/`addImport` afterwards
   throws immediately at the call site (the producer), not later at the
   encoder (the symptom).

Deliverable: an `## Implementation Plan` ratifying the design with exact
touch points (`src/emit/binary.ts`, `src/codegen/expressions/late-imports.ts`,
`addUnionImports` in `src/codegen/index.ts`), the migration order, and the
perf budget — then sized child slices for an Opus dev to implement.

## Why model: fable

Six Opus-level point fixes have not ended the class. The fix that does is a
cross-cutting representation/invariant decision touching every index producer
and both backends — wrong choices here either false-fire on long-tail
constructs (a hard validator rejecting valid modules) or miss the next
instance again. This is decision work, not instance work.

## Acceptance criteria

- A ratified design doc (in this issue) choosing among options 1–3 with
  rationale, plus sized child issues.
- Emit-time validation covers all index spaces and is always-on (or the
  ratified equivalent), with measured emit-time overhead < 5% on the
  playground-examples corpus.
- #1915's repro (`class A extends Uint8Array {}` under `--target standalone`)
  produces a named, located codegen error (or compiles correctly) — never the
  raw encoder RangeError.
- A regression test that simulates a stale captured index and asserts the
  named-error path fires.
