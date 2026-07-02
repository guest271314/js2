---
id: 2956
title: "Linear backend consumes the IR front-end: wire the selector + LinearEmitter into generateLinearModule"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir, codegen-linear
language_feature: compiler-internals
goal: backend-agnostic-ir
depends_on: [2953, 2954]
related: [1585, 1713, 2710, 1852]
origin: "2026-07-02 July Fable audit §5 (production linear compilation consumes zero IR; #1585 is investigation-only)"
---

# #2956 — the backend fork sits ABOVE the IR

## Problem

`--target linear` branches at `src/compiler.ts:861` and hands the **AST**
to `generateLinearModule` (src/codegen-linear/index.ts, 5.5k lines) — the
IR selector and from-ast never run for linear compiles. "Backends differ
only at lowering" is therefore true for **no shipping code path**: the
linear backend is a second direct AST→Wasm front-end (15.9k lines,
maintained but far behind on parity: fail-loud rejects for typeof/await/
spread/regex, no dynamic-value representation, no closures-via-IR).
#1585 (dual-target IR architecture) is the investigation umbrella; no
implementation issue existed.

## Approach (architect spec is the first deliverable)

Mirror the WasmGC overlay pattern (#2138 shape), not a big-bang port:

1. **Spec:** a linear `IrLowerResolver` twin — `integration.ts` is today
   hardwired to the WasmGC codegen context (imports 8 codegen modules,
   patches `ctx.mod.functions` slots). Extract the context-facing surface
   (funcMap/typeIdx/slot-patch/import registration) into an interface both
   backends implement. #2710 (late-bound module indices) reduces the
   index-shift hazard here.
2. **Slice 1:** for IR-claimed _numeric/control-flow_ functions under
   `--target linear`, build IR once and lower via LinearEmitter into the
   linear module's slots; everything else stays on the linear direct path
   (its own demote channel, bucketed + ratcheted like #1376).
3. **Slice 2+:** widen families as LinearEmitter grows (aggregates via
   codegen-linear/layout.ts, the #1852-G4 f64+tag dynamic cell, strings).
   Async/closures explicitly deferred (blocked on linear closure + Promise
   runtime — do not promise them here).

## Acceptance criteria

- Architect spec recorded here (resolver interface + slice map) before dev
  dispatch.
- A claimed numeric function compiles once via IR into the linear module;
  cross-backend corpus rows flip from expectLinearUnsupported to executed
  parity.
- Linear fallback reasons bucketed against a baseline (clone of
  check-ir-fallbacks), so parity progress banks.
