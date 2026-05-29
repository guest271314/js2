---
id: 1715
title: "Minimal bytecode emitter + dispatch loop for an IR subset (backend-agnostic proof point)"
status: backlog
created: 2026-05-29
updated: 2026-05-29
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, runtime, architecture
language_feature: n/a
es_edition: n/a
goal: backend-agnostic-ir
sprint: 57
depends_on: [1713]
related: [1584, 1131, 1714]
needs_architect_spec: true
---
# #1715 — Minimal bytecode emitter + dispatch loop for an IR subset (proof point)

## Problem

#1584 proposes a full Wasm-GC-native bytecode interpreter (8–12 weeks, register
+ accumulator, ~120–150 opcodes, eval/Function support, Acorn runtime parser).
That is a large speculative investment. Before committing to it, we need to
de-risk the single architectural claim it rests on:

> Can the typed IR be lowered to a non-Wasm execution target (a bytecode stream
> run by a dispatch loop) through the same backend seam that targets WasmGC?

This issue answers that for **one issue's worth of effort** by building a
*minimal, throwaway-grade* bytecode backend for a tiny IR subset. It is the
proof point gating the #1584 decision — if the #1713 trait cannot cleanly
express a bytecode target, we learn it now, not 8 weeks in.

## Scope — deliberately minimal

Cover ONLY this IR subset (the smallest set that proves dispatch works):

- integer/f64 arithmetic (`add`, `sub`, `mul`)
- local get/set
- `const`
- `return`
- ONE conditional branch (`br_if` → the IR's existing two-arm tail shape)

NO objects, NO arrays, NO closures, NO calls, NO strings, NO exceptions. Those
are #1584's job. The subset is exactly what `lower.ts` already handles for a
function like `function f(a, b) { return a > 0 ? a + b : a - b; }`.

## Approach

1. `BytecodeEmitter implements BackendEmitter` (from #1713) — but only the
   primitives the subset needs; the rest `throw not-supported-in-proof`. It
   emits a flat opcode array (a simple stack or register encoding — the
   architect spec picks; register+accumulator per #1584's ADR direction is
   preferred so the proof informs that design, but a stack machine is
   acceptable for the proof if simpler).
2. A dispatch loop — written in TypeScript (so it can later itself be compiled
   by js2wasm per #1584), executing the opcode array against a small frame
   (locals array + accumulator/operand stack), returning a number.
3. A test: for a handful of in-subset functions, the bytecode-interpreted
   result equals the WasmGC-compiled result equals the plain-JS result. This
   triple equivalence is the proof.

## Acceptance criteria

1. A `BytecodeEmitter` exists behind the #1713 trait, emitting opcodes for the
   minimal IR subset listed above.
2. A TypeScript dispatch loop executes those opcodes and returns correct
   numeric results.
3. A test proves, for ≥3 in-subset functions (one arithmetic, one with a local,
   one with the conditional branch), that bytecode-interpreted output ==
   WasmGC output == JS output.
4. The opcode encoding choice (stack vs register+accumulator) and findings are
   written up in the issue — this is the input the #1584 ADR consumes.
5. Zero conformance delta (the WasmGC path is untouched; this adds a parallel
   experimental backend behind a flag, not a default path).

## Decision this proof informs

- **If clean** — the #1713 trait genuinely abstracts execution model, not just
  Wasm-op selection. #1584 Phase 1 is greenlit on a sound foundation, and its
  opcode-set ADR builds on this proof's encoding findings.
- **If the trait fights the bytecode target** — we capture exactly where (the
  issue write-up), feed it back into a #1713 trait revision, and re-scope #1584
  before committing the multi-week investment.

## Notes / scope

- Status `backlog` → `ready` once #1713 merges. This is the **stretch** s57
  backend proof; #1714 (linear) is the primary and must land first if capacity
  is tight.
- Throwaway-grade is fine and intended. The deliverable is *knowledge + a green
  triple-equivalence test*, not production code. Keep it behind an explicit
  experimental flag so it never affects default compilation.
- This is explicitly the first, scoped-down slice of #1584's Phase 1 step 3–4
  ("bytecode emitter as a second IR backend" + "dispatch loop in TypeScript"),
  reduced to the minimum that validates the seam.
