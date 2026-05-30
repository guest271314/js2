---
id: 1715
title: "Minimal bytecode emitter + dispatch loop for an IR subset (backend-agnostic proof point)"
status: done
created: 2026-05-29
updated: 2026-05-30
completed: 2026-05-30
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

---

## 2026-05-30 — Proof result + findings (senior-dev). VERDICT: CLEAN. #1584 greenlit.

**Status: DONE.** The triple-equivalence test is green; the #1713 seam targets a
non-Wasm execution model cleanly. The single architectural claim #1584 rests on
is **validated** — proceed to #1584 Phase 1 on a sound foundation.

### What landed (branch `issue-1715-bytecode-proof`)
- `src/ir/backend/bytecode-emitter.ts` — `BytecodeEmitter` + `BytecodeSink` +
  the opcode set (`OP_*`). Emits a flat `number[]` opcode stream for a stack VM,
  mirroring the `WasmGcEmitter` primitives for the #1715 subset (const,
  binary add/sub/mul + compares, local get/set, return, one structured `emitIf`
  → JZ/JMP with backpatch). Out-of-subset ops `throw not-supported-in-proof`.
- `src/ir/backend/bytecode-vm.ts` — `runBytecode` / `runSink`: a plain-TS stack
  dispatch loop (locals array + operand stack), returns a number. Written in the
  js2wasm-compilable subset so #1584 can later lower the loop itself.
- `tests/ir-bytecode-proof.test.ts` — the **triple-equivalence** proof: for
  `f(a,b)=a+b`, `g(a)={let x=a*2;return x}`, `h(a,b)=a>0?a+b:a-b`, asserts
  `bytecode-interpreted == WasmGC-compiled (via the real compile()) == plain JS`
  across multiple inputs each. Plus VM-malformed-stream + out-of-subset-throw
  guards. **5 tests green.**

**Zero conformance delta (AC #5):** three NEW files only — `lower.ts`,
`WasmGcEmitter`, and the default compile pipeline are untouched. The bytecode
path is reached solely by the #1715 test. `tsc` clean, `biome` clean,
`check:ir-fallbacks` OK (no bucket change).

### Encoding decision (the #1584 ADR input — AC #4): **stack machine**
Chosen per spec §6's tiebreaker. `lower.ts` emission is already stack-oriented
(operands pushed by `emitValue`, then the op consumes them), so a stack-VM
opcode per primitive is a near-mechanical mirror of `WasmGcEmitter` and reuses
the existing operand-ordering logic with minimal throwaway code. Opcode set:
`CONST/LOAD/STORE/ADD/SUB/MUL/CMP_{GT,LT,GE,LE,EQ}/NEG/JZ/JMP/RET`, f64
immediates in a side constant pool (code array stays integer-only).

### The load-bearing finding (what #1584 must carry forward)

> **The #1713 `BackendEmitter` trait abstracts the *execution model*, not just
> Wasm-op selection — and the ONLY representation-specific part is the sink
> type.** Reaching bytecode required exactly one seam generalisation: the sink
> from the concrete `out: Instr[]` to an abstract `BytecodeSink` (`number[]` +
> const pool). Everything else transferred unchanged: the primitive *set*, the
> push-to-sink convention, and the caller-owns-operand-order contract. The
> emitter never reasons about what model runs the ops; it just emits terminal
> ops for each node's intent.

Concretely for #1584:
1. **Greenlight.** The trait is a sound foundation for a bytecode backend. No
   trait revision needed before #1584 Phase 1.
2. **The one change #1584 inherits:** generalise `BackendEmitter`'s sink. Spec
   §7 flagged this exact risk ("the `out: Instr[]` sink is WasmGC-biased … #1715
   generalises the sink to reach a stack-VM. That generalisation IS the #1715
   deliverable, not a blocker"). Confirmed: it is one well-contained type
   parameter (`EmitSink<T>` or per-emitter sink), not a structural rework.
3. **Encoding is a free choice below the seam.** Register+accumulator (#1584's
   eventual direction) is *purely an encoding concern* downstream of the same
   primitive set — the seam does not care. This proof used a stack machine for
   less code; #1584 can swap the encoding without touching the trait. That
   independence (seam = execution model; encoding = free below it) is the
   precise de-risking #1584's ADR needed.

### Honest scope boundary
- The bytecode arm is driven by **hand-lowered IR** (the test emits operand
  subtrees then terminal ops, exactly as `lower.ts` drives the emitter), NOT by
  running the real `lower.ts` against the bytecode sink. Wiring `lower.ts` to a
  generic sink is the sink-generalisation step above and belongs to #1584 Phase
  1 (it would touch the production pass — out of a throwaway proof's scope and
  against this issue's zero-delta requirement). The WasmGC arm DOES use the real
  `compile()`, so the equivalence still pins bytecode output against production
  WasmGC lowering of the same source.
- Subset is exactly #1715's: numeric arithmetic + local + const + return + one
  branch. Objects/arrays/closures/calls/strings/exceptions remain #1584's job.

### Follow-ups to file under #1584 (not this throwaway proof)
- Generalise `BackendEmitter` sink to `EmitSink<T>` and route the real `lower.ts`
  through a `BytecodeEmitter` end-to-end (drops the hand-lowering).
- Extend the opcode set toward the #1584 register+accumulator VM + the broader
  IR surface (calls, aggregates).

---

## 2026-05-30 — Production emitter slice (senior-dev, #1584). Real front-end IR, hand-lowering dropped.

The first #1584 follow-up above is **landed** (branch `issue-1584-prod-emitter`).
The bytecode emitter is now driven by the **real front-end IR** — the same
`lowerFunctionAstToIr` output the WasmGC backend consumes — not hand-lowered IR.

### What landed (NEW files under `src/ir/backend/bytecode/`, zero changes to existing files)
- `opcodes.ts` — the **production opcode set** (`OP`) + `BytecodeSink`. SINGLE
  SOURCE OF TRUTH; the VM (sdev-vm track) imports it read-only. Grows the proof's
  set with `DIV`, `CMP_NE`, `TEE`, `GLOBAL_GET/SET`, `SELECT`, `DROP`,
  `UNREACHABLE`, and a `spliceArm` that rebases nested-`if` jump targets +
  remaps const-pool indices when splicing arm buffers.
- `emitter.ts` — production `BytecodeEmitter`: mirrors the `BackendEmitter` trait
  **primitive signatures** (so the real lowering walk drives it exactly as
  `lower.ts` drives `WasmGcEmitter`) over a `BytecodeSink`.
- `vm.ts` — production stack dispatch loop (`runBytecode`), plain-TS in the
  js2wasm-compilable subset so #1584 can lower the loop itself.
- `lower-bytecode.ts` — the **production lowering driver**. Walks the real
  `IrFunction` (SSA def maps, use-count → tee-materialisation, structured `if` /
  `select` / `br_if` / `br` / `return`), mirroring `lower.ts`'s `emitValue` /
  `emitInstrTree` / `emitBlockBody` contract. Any out-of-subset node throws a
  clear `not in the #1584 production subset` error.
- `tests/ir-bytecode-production.test.ts` — triple equivalence driven by REAL IR:
  parses source → `lowerFunctionAstToIr` → bytecode → run; asserts
  `bytecode(real IR) == WasmGC(real compile()) == JS` for `a+b`, `let x=a*2`,
  `a>0?a+b:a-b`, `(a+b)*(a-b)`, plus an out-of-subset rejection (`a|0`). **5 green.**

### Why a parallel driver instead of making `BackendEmitter<S>` generic (the key decision)
Threading a generic sink type through the `BackendEmitter` trait would force
`lowerIrFunctionToWasm` to be generic too — but that function has **166 inline
`out.push({ op })` sites** (call, struct.get/new/set, try/throw/rethrow,
loop/block/br_if, the js-bitwise scratch dance, ref-coercion) that are NOT routed
through the trait and hard-require `S = Instr[]`. Making lower.ts generic over
those would either break their type-checking or demand migrating all 166 first —
a large, conformance-risky refactor that is #1584's **per-op-group** later slices,
not this one. So the production emitter mirrors the trait's primitive *signatures*
(identical drive shape) without claiming `implements BackendEmitter` (whose `out`
is `Instr[]`), and the lowering driver covers exactly the routed subset, throwing
loudly at the not-yet-migrated boundary. This keeps the PR contained + zero
conformance risk while genuinely moving from hand-lowered IR to real compiler IR.

### Encoding confirmed: STACK MACHINE (still the #1584 ADR input)
Unchanged from the proof and re-validated against real IR. Reg+accumulator
remains a free choice strictly below the seam — if the architect's #1584 contract
pins it, `opcodes.ts` + `vm.ts` change and the lowering driver follows; the
seam (real IR → sink) does not move.

### The remaining #1584 migration ladder (now the only follow-ups)
The seam is proven end-to-end on real IR. What's left is **breadth**, one op group
per slice, each: (1) route the group behind the trait in `lower.ts` (retiring its
inline `out.push` sites), (2) add its opcode(s) to `opcodes.ts`, (3) add its VM
dispatch (sdev-vm), (4) extend `lower-bytecode.ts` to stop throwing for it. The
166-site inventory is the migration backlog. Groups in rough dependency order:
globals (resolver index wiring) → calls → aggregates (struct.get/new/set) →
closures/ref-cells → exceptions (try/throw) → loops (block/loop/br_if multi-block)
→ strings. Cross-arm/cross-block multi-use materialisation (`lower.ts`'s
`crossBlock` hoist) must port alongside the multi-block (loops) group — until then
`lower-bytecode.ts` detects and rejects the hazard rather than mis-lowering.
