---
id: 2949
title: "IR dynamic value representation: JsTag-carrying `dynamic` kind in IrType (make untyped JS claimable)"
status: in-progress
assignee: ttraenkler/fable-1
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [1852, 1926, 2138, 2135, 2855]
origin: "2026-07-02 July Fable audit (plan/log/analysis-2026-07/00-ir-async-standalone-audit.md §1)"
---

# #2949 — the IR's type system is Wasm types, not JS types

## Problem

`IrType`'s leaf is `{kind: "val", val: ValType}` (`src/ir/nodes.ts:56ff`).
There is **no dynamic / any / JsTag representation inside the IR**. Every
value the front-end cannot statically resolve to a concrete Wasm type causes
whole-function rejection (`param-type-not-resolvable`,
`type-resolution-failure`, most of `body-shape-rejected` transitively).

Measured consequence (#2138 slice-2 measurement): the IR claimed **8 bodies
across 4 of 233 corpus files** on a JS-heavy corpus. The bucket-to-zero
program (#2855/#2856–#2859) is measured against 13 typed playground
examples; zeroing those buckets leaves the test262-scale claim rate in
single digits. **"IR as the only front-end" is arithmetically unreachable
without dynamic values in the IR type lattice.** This is the north star's
true critical path and previously had no filed issue.

The codegen-level D1 value-rep program (JsTag enum, brands, boxed-any
carriers — #1852/#1926/#2040 family) is done or in flight, but it lives
below the IR: the IR and the value-rep model have never met.

## Approach (architect spec first — this issue starts as the spec)

1. **Spec slice (this issue, first deliverable):** extend the `IrType`
   lattice with `{kind: "dynamic", tag?: JsTag}` (statically-known-tag
   refinement optional), define verifier rules (what ops accept dynamic
   operands, where explicit `IrInstrBox`/`IrInstrUnbox`/`IrInstrTagTest`
   nodes are required), and define the lowering contract: dynamic maps to
   the existing boxed-any carrier on WasmGC (per #1852 carrier policy) and
   to the f64-value+i32-tag cell on linear (deferred, #1852-G4/#2956).
   The trait methods `emitBox`/`emitUnbox`/`emitTagLoad` already exist
   (declared-optional) on `BackendEmitter` — this spec makes them
   load-bearing (coordinate with #2953).
2. **Slice 2:** `from-ast.ts` emits dynamic-typed IR for unresolvable
   locals/params instead of throwing; selector capability rows widen
   accordingly (#2135 table, claim instead of defer for
   `param-type-not-resolvable` / `type-resolution-failure` shapes).
3. **Slice 3:** lower dynamic ops via the canonical boxed-any helpers
   (reuse `addUnionImportsViaRegistry` / native classifier paths — do NOT
   mint a second boxing engine; June audit D4 rule).
4. **Slice 4:** measure claim-rate delta on the 233-file corpus + full
   test262 (`ir_first` lane, #2947); ratchet buckets down with the
   measurement as evidence.

## Acceptance criteria

- IrType has a dynamic kind with documented verifier rules; verify.ts
  enforces them (hard-fail lane stays on).
- A function with an unannotated `any` param round-trips: claimed by the
  selector, IR-built, lowered, byte-behavior-equal to legacy on the
  equivalence suite.
- Claim-rate measurement recorded here (corpus + test262 scale), with the
  before/after bucket counts.
- No second boxing implementation: lowering routes through the existing
  boxed-any registry helpers.

## Risks

- Blast radius is the whole IR pipeline; keep slices flag-free but
  additive (a dynamic-typed function that would previously reject is the
  only behavior change).
- Interaction with #2138 skip-set: a claimed-because-dynamic function must
  still satisfy the skipped-slot hard-error contract.
