---
id: 3141
title: "Self-hosted stdlib pilot: compile math-helpers as TS builtin source through our own IR pipeline (porffor model)"
status: ready
sprint: Backlog
created: 2026-07-11
updated: 2026-07-11
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen, stdlib
language_feature: compiler-internals
goal: ir-full-coverage
related: [3090, 2855, 2527]
origin: "plan/bloat-reduction-battle-plan.md §4 — highest-leverage lever (−45–55k net at scale), pilot-gated"
---

# #3141 — Self-hosted stdlib pilot: `math-helpers.ts` via our own pipeline

## Problem

~76k fn-lines of stdlib behavior are hand-emitted as `Instr[]`-building TS
(`array-methods.ts` 9.6k, `object-runtime.ts` 10.1k, …). Porffor covers the same
surface in ~14k lines of **self-hosted TS builtins** its own compiler precompiles at
build time (measured 2026-07-11: `compiler/builtins/*.ts` + a 307-line
`precompile.js`; e.g. all of Array = 1,038 lines of TS vs our 9.6k of assembly).
See `plan/bloat-reduction-battle-plan.md` §2/§4.

## Pilot scope (deliberately minimal)

Rewrite the **`src/codegen/math-helpers.ts` family (1,688 lines)** as TS builtin
source compiled through our IR path at build time, linked via `src/link/`
(core-wasm linking, #2527). Chosen because: pure f64 math, no object-graph or
string-rep interaction, minimal intrinsics surface, dense test262 Math coverage.

## Implementation Plan (architect)

1. **Intrinsics dialect (main deliverable).** Do NOT copy porffor's raw inline-wasm
   template escape (their flat `(f64,i32)` rep makes it trivial; our WasmGC struct rep
   does not). Define typed intrinsic *functions* (`__f64_reinterpret`, `__tag_of`, …)
   that `src/ir/from-ast.ts` recognizes and lowers as IR nodes so the
   `BackendEmitter` fork keeps them portable to both backends.
2. **Precompile step.** Build-time script compiling `stdlib/*.ts` (new dir) through
   `compileSource` with `experimentalIR` + IR-first for the builtin module; emit a
   linkable core-wasm artifact (or serialized func bodies), commit + hash-verify it;
   CI recompiles fresh and diffs (porffor's `builtins_precompiled.js` model).
3. **Swap-in.** Route the Math-helper registrations to the precompiled funcs; delete
   the hand-emission bodies from `math-helpers.ts`.
4. **Measure.** Equivalence suite + full CI + `merge_group` (standalone floor), test262
   Math buckets net ≥ 0, benchmark sidebar delta. Write the scale-up verdict
   (per-family LOC compression + perf delta) into this issue.

## Acceptance criteria

- `math-helpers.ts` hand-emission deleted (~−1.5k net after new stdlib source).
- Both backends (WasmGC + linear where applicable) consume the same builtin source.
- test262 net ≥ 0 on merge_group; benchmark regression < 10% on Math-heavy benches.
- A written GO/NO-GO recommendation for scale-up (battle-plan slice 9).

## Non-goals

- No big-bang stdlib conversion; one family only.
- No new host imports (dual-mode rule: standalone-native required).
