---
id: 3029
title: "Clean compiler architecture umbrella: layered module map, five-part backend contract, reviewability ratchets"
status: ready
sprint: current
created: 2026-07-04
updated: 2026-07-04
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir, codegen, codegen-linear, compiler
language_feature: compiler-internals
goal: maintainability
related: [3030, 742, 1851, 1852, 1916, 1927, 1930, 1859, 1860, 2043, 2710, 2855, 2949, 2950, 2953, 2956]
origin: "2026-07-04 user directive: refactor into a clean architecture humans can review/extend, open to new backends (MLIR or others)"
---

# #3029 — Refactor into a reviewable, extensible, backend-open architecture

**Normative target picture:**
[`docs/architecture/target-architecture.md`](../../docs/architecture/target-architecture.md)
(written with this issue). This umbrella tracks the sequenced slices; each
slice PRs independently. Sibling: **#3030** (the serializable IR contract —
the interchange boundary this architecture is layered around).

## Problem

The compiler ships 73.9% test262 but has accumulated organically:

- `compileCallExpression` is ~9.1k lines with ~125 string-matched dispatch
  arms (#742); `src/codegen/index.ts` is 15.9k lines. Review cost and
  merge-conflict rate scale with these files, not with the change.
- The `BackendEmitter` trait exists (#1713/#1714) but 74 `pushRaw` sites in
  `src/ir/lower.ts` bypass it (#2953), its output sink is hardwired to the
  Wasm `Instr[]` shape, and there is **no declared contract at all** for the
  module-level half of a backend (function slots, imports, type
  registration) — that lives as WasmGC `ctx.mod` mutation. A new backend
  (MLIR, Cranelift, a different Wasm strategy) today has no interface to
  implement; it would have to be a fourth hand-rolled path.
- Layer boundaries exist in the docs but not in the import graph:
  `src/ir/integration.ts` imports 8 `src/codegen/` modules, so the
  "backend-neutral" middle-end is compile-time coupled to one backend.
- "Reviewable" has no enforcement: no file-size ceiling, no
  dependency-direction check, dispatch chains keep growing.

The June 2026 quality review (B− overall, C− codegen core) and the two-axes
doctrine already diagnose all of this; what has been missing is the **target
module architecture** and the ordered cut-lines to get there. That is this
issue.

## Target (summary — the doc is normative)

1. **Layer stack** L1 frontend → L2 ir-build → L3 backend-neutral IR (the
   serializable waist, #3030) → L4 legalization → L5 backends → L6 emit/link
   → L7 runtime. Imports point strictly downward, CI-checked.
2. **Five-part backend contract** — a new backend implements exactly:
   `TypeConverter` (#1851 L3), `BackendLegality` (#1851 L4),
   `BackendEmitter<Sink>` (sink generalized off `Instr[]`),
   `LayoutResolver` (extracted from `integration.ts`, #2956 item 1), and
   `ModuleAssembler` (new — name-based module assembly, no absolute-index
   baking; converges with #1916/#2710/#2043).
3. **Out-of-tree backends are first-class** via the serialized IR (#3030) —
   the recommended route for MLIR-class consumers.
4. **Reviewability rules with ratchets**: R-SIZE (file-size baseline,
   shrink-only), R-DEP (import-direction check), R-DISPATCH (table-driven
   registries), R-ESCAPE (pushraw-ok tags, #2953), R-OWN (subdir README
   contracts, #1859), R-LOUD (#1858).
5. **Neutral directory layout**: `src/frontend/`, `src/ir/`,
   `src/backend/{contract,gc,linear,bytecode}/`, `src/emit/`, `src/link/`,
   `src/runtime/` (resolves #1860).

## Slices

Tier ruling (user, 2026-07-04): **structural cut-lines = Fable-required**
(interface freezes, contract definitions, index-identity design);
**mechanical waves = Opus-executable** (file splits, moving code behind
frozen interfaces, call-site migration), each gated by byte-identity /
equivalence / full CI.

| Slice                                        | Tier      | Size               | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Depends on                                                    |
| -------------------------------------------- | --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **S1 — Backend contract v1**                 | **Fable** | M                  | Freeze the five interfaces as code: `src/ir/backend/contract.ts` (or split files) declaring `TypeConverter`, `BackendLegality` (promote `legality.ts`), `BackendEmitter<Sink>` with the sink made a type parameter (bytecode's `number[]` sink is the existing proof it must generalize; an MLIR builder is the future one), `LayoutResolver`, `ModuleAssembler` (declaration only — implementation is S4/S5). Includes the contract README (what each part owns, operand-order rules, memoization ownership) and a conformance test skeleton per interface. Byte-inert. | —                                                             |
| **S2 — pushRaw families behind the trait**   | Opus      | L                  | Finish #2953's remaining families (unions/boxing, closures, coercions/null, funcref, Promise-or-declared-deferred) + its count ratchet. Already sliced and in-progress there — this umbrella just sequences it.                                                                                                                                                                                                                                                                                                                                                          | S1 (trait surface)                                            |
| **S3 — LayoutResolver extraction**           | Opus      | M                  | Move `integration.ts`'s resolver construction behind the S1 interface: the context-facing surface (funcMap/typeIdx lookup, slot patching, import registration) becomes an interface the WasmGC context implements. Kills the `ir → codegen` import direction (then flip R-DEP to enforcing for `src/ir/`). Byte-identity gate. This is also #2956's prerequisite item 1 — coordinate; do it once, here.                                                                                                                                                                  | S1                                                            |
| **S4 — ModuleAssembler design**              | **Fable** | M                  | The one genuinely dangerous cut: who owns function slots, import/export/type registration, and index identity per backend. Must be designed against the live index-shift regime (`addUnionImports`, `late-imports.ts`, ≥7 historical regressions) and the in-flight symbolic-func-refs direction (#1916) + late-bound indices (#2710) + #2043 — the assembler is where those converge instead of three coexisting relocation regimes. Deliverable: ratified spec section here + the interface body in contract.ts.                                                       | S1; read #1916/#2710 state first                              |
| **S5 — Assembler implementations**           | Opus      | M–L                | WasmGC `ModuleAssembler` implementing S4 over the existing `ctx.mod` (adapter first, migration second); linear twin over `generateLinearModule`'s module state. Byte-identity + full CI per step.                                                                                                                                                                                                                                                                                                                                                                        | S4                                                            |
| **S6 — Directory re-layout + READMEs**       | Opus      | M                  | `git mv` waves per the migration map in the target doc (+ `src/backend/{gc,linear,bytecode}` naming, #1860) + per-subdir contract READMEs (#1859). Pure mechanics but high conflict surface: schedule in a quiet merge-queue window, one directory per PR, coordinate with the lead so no in-flight branch is stranded.                                                                                                                                                                                                                                                  | S1–S3 landed (so the moved code is already behind interfaces) |
| **S7 — CI reviewability ratchets**           | Opus      | S–M                | `scripts/check-file-sizes.mjs` (baseline JSON, shrink-only, like ir-fallback-baseline) + `scripts/check-layer-imports.mjs` (R-DEP; reads per-subdir README declared deps) wired into `quality`. Land EARLY — it locks the rules before the waves. R-DEP starts warn-only for known violations (the baseline lists them), enforcing per-directory as S3/S6 clear them.                                                                                                                                                                                                    | rules in the doc (done)                                       |
| **S8 — calls.ts decomposition continuation** | Opus      | L (many small PRs) | #742 under the new rules: keep extracting self-contained guard/dispatch blocks with the WAT-hash oracle, then the table-driven callee registry. Counts against the R-SIZE baseline (each PR shrinks it).                                                                                                                                                                                                                                                                                                                                                                 | S7 (ratchet banks the progress)                               |
| **S9 — MLIR feasibility memo**               | **Fable** | S                  | One-pager: map IR (block-arg SSA, symbolic refs, effects) onto an MLIR dialect; decide in-tree emitter vs out-of-tree consumer of #3030's serialized IR (expected answer: out-of-tree first). Explicitly a memo, not a commitment.                                                                                                                                                                                                                                                                                                                                       | #3030 T1–T3                                                   |

Sequencing: S1 → {S2, S3} → S4 → S5 → S6; S7 immediately (parallel); S8
continuous; S9 after #3030's serializer exists.

## Acceptance criteria (umbrella)

- [ ] `docs/architecture/target-architecture.md` merged and linked from
      `codegen-axes.md` (this PR).
- [ ] S1 contract merged; the three existing emitters (`WasmGcEmitter`,
      `LinearEmitter`, `BytecodeEmitter`) type-check against
      `BackendEmitter<Sink>` with their own sink types.
- [ ] `src/ir/` has zero imports from `src/codegen/` (S3), enforced by R-DEP.
- [ ] `ModuleAssembler` spec ratified (S4) and implemented for WasmGC +
      linear (S5) with no test262 regression.
- [ ] R-SIZE and R-DEP checks live in `quality` with committed baselines
      that only shrink (S7).
- [ ] Directory layout matches the migration map (S6); every `src/` subdir
      has a contract README.
- [ ] A design-only "how to add a backend" section exists (target doc) whose
      five interfaces are all real code — verified by the conformance test
      skeleton compiling against a stub backend.

## Risks

- **Index identity (S4/S5)** is the compiler's #1 historical regression
  class (≥7 numbered regressions from absolute-index baking). That is why
  S4 is Fable-tier and why S5 lands as adapter-first with byte-identity
  gates, never a rewrite.
- **Directory moves (S6)** conflict with every in-flight branch. One
  directory per PR, lead-scheduled, `git mv` only (history follows), no
  logic changes in move PRs.
- **Contract freeze too early**: S1 freezes _shape_, not completeness —
  methods may be added (additive) as #2953/#2956 discover needs; what S1
  forbids is new bypasses around the seam.
- **Duplication with in-flight issues**: #2953 (S2), #2956 (S3 overlap),
  #742 (S8) keep their own issue files and owners; this umbrella sequences
  them and must not double-dispatch. Check assignees before claiming.
