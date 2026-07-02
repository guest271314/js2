---
id: 2955
title: "De-polymorph the IR front-end on string mode: abstract IR string ops resolved at lower time"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
language_feature: strings
goal: ir-full-coverage
related: [2953, 679, 2949]
origin: "2026-07-02 July Fable audit §5 (identical source builds different IR per string mode)"
---

# #2955 — identical source builds different IR depending on nativeStrings

## Problem

`src/ir/from-ast.ts` branches on `resolver.nativeStrings?.()` at
:2620, :2874, :2938, :3173, :3309 (and `lower.ts` consults it at :173,
:186): with native strings on, IR construction emits `__str_*` helper
calls; with host strings, it emits host-import shapes. So the **front-end
IR is representation-polymorphic** — a violation of the north star ("one
front-end; backends/modes differ at lowering") _within_ the WasmGC family,
and a drift breeding ground (June audit D4): every new string feature must
be implemented twice at IR-build time.

## Approach

1. Introduce abstract IR string ops (e.g. `IrInstrStrConcat`,
   `IrInstrStrCompare`, `IrInstrStrLen`, `IrInstrStrIndex`,
   `IrInstrStrFromLiteral` — audit the 5 branch sites for the exact op
   set) emitted unconditionally by from-ast.
2. Resolve the mode in `lower.ts` (or the emitter, coordinating with
   #2953's trait discipline): native mode lowers to `__str_*` helpers,
   host mode to the wasm:js-string imports — exactly the sequences emitted
   today, byte-identical per mode.
3. Verifier: string ops type as the existing string ref types; no new
   verifier surface beyond op signatures.

## Acceptance criteria

- from-ast.ts contains zero `nativeStrings` reads (grep-gated).
- Same source produces identical IR (structural compare) in both string
  modes; per-mode lowered bytes identical to before.
- Equivalence suite green in both modes; string-heavy test262 sample
  net-zero.
