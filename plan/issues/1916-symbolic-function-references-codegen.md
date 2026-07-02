---
id: 1916
title: "Symbolic function references in WasmGC codegen — retire the late-import index-shift machinery"
status: in-progress
assignee: ttraenkler/dev-1916f
pipeline_unblocked: 1927
sprint: current
model: fable
created: 2026-06-10
updated: 2026-07-02
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [2710, 1899, 1985]
---
# #1916 — Symbolic function references in WasmGC codegen

## Problem

The WasmGC backend bakes **absolute function indices** into instruction
streams as it compiles. Any import added after bodies exist shifts every
defined-function index, so compensation machinery must find and patch every
instruction array in flight:

- `shiftLateImportIndices` (`src/codegen/late-imports.ts:139-270`) walks 13+
  roots: `mod.functions`, `fctx.body`, `savedBodies`, `currentFunc`,
  `funcStack`, `parentBodiesStack`, `liveBodies`, `pendingInitBody`,
  `funcMap`, `nativeStrHelpers`, `pendingMethodTrampolines`, exports, elem
  segments, `declaredFuncRefs`.
- A **second** shift regime (`reconcileNativeStrFinalizeShift`,
  `late-imports.ts:355+`, #1677) exists because raw `addImport` deliberately
  doesn't shift (the #618 revert).
- Context fields exist *only* to make bodies reachable for the shifter
  (`liveBodies`, `context/types.ts:940-946`, citing #1384) — the context
  schema is shaped by repair-pass reachability.
- `generateModule`'s prologue (`index.ts:954-1103`) is a 150-line ordering
  ballet of which emission must precede which import registration.

At least 7 numbered regressions trace to this one design decision: #618,
#1109, #1384, #1525b, #1666, #1677, plus the #172-era class trampoline bug.
The IR layer already proved the alternative works: symbolic refs instead of
raw indices (`src/ir/nodes.ts:22-28`), which is exactly why IR integration
doesn't need `shiftLateImportIndices` (`ir/integration.ts:20-23`).

## Proposed approach

1. Introduce `FuncHandle` — one shared mutable `{ index: number }` (or
   name-keyed) object per function/import, interned in the codegen context.
2. Emit call/ref instructions as `{ op: "call", target: FuncHandle }`;
   resolve handles to concrete indices **once**, at binary-encoding time
   (`src/emit/binary.ts`), the same place type indices are already final.
3. `addImport`/`ensureLateImport` then renumber by mutating handles — no
   instruction walking, no body registry, no ordering constraints.
4. Delete `shiftLateImportIndices`, `reconcileNativeStrFinalizeShift`,
   `liveBodies`, `pendingLateImportShift`, and the prologue ordering
   comments as they become dead.
5. Migrate incrementally: accept `number | FuncHandle` in the `Instr` union
   during transition; ratchet raw-number call sites to zero (same pattern as
   the #1095 cast budget).

## Acceptance criteria

- No instruction-walking shift pass remains; `git grep shiftLateImportIndices` is empty.
- Equivalence suite + test262 sharded CI green (net ≥ 0, no bucket regressions).
- `liveBodies` / `parentBodiesStack` bookkeeping removed from `CodegenContext`.
- A regression test that adds a late import after N bodies are compiled and
  validates the binary.

## Source

Compiler quality review 2026-06
(`docs/architecture/compiler-quality-review-2026-06.md`), WasmGC codegen
section. Related: #1677 (unified two shift regimes; this removes the regime),
#1899 (funcIdx authority contract). Needs an architect spec before dev
dispatch (`/architect-spec`).

## Amendment (2026-06-11, analysis program)

Symbolic references as specced fix index-shift fragility but keep
NAME-keyed identity: `IrFuncRef { name }` is still a string (report 05
§3), so the collision class survives the migration — `${Class}_${method}`
colliding with a user `function A_m()` (#1983), `${name}_valueOf`
last-literal-wins dispatch (#1989, now specced onto typed refs), and the
`__sget_<name>` family. Requirement added: handles must be
**collision-free FuncIds derived from the declaration site /
ts.Symbol**, with names demoted to debug metadata. The instance-side twin
($shape, #2009) covers struct identity; this issue owns function/registry
identity. Full analysis: plan/log/analysis-2026-06/05-structure-review.md
§3.

## Reconciliation with #2710 + staged plan (dev-1916f, 2026-07-02)

Unblocked: #2167 resolved — Fable re-enabled 2026-07-02 (coordinator
direction); `blocked_by` cleared.

**Foundation decision: #1916 builds ON #2710's landed FuncHandle
foundation — it does NOT introduce a second identity mechanism.** While
this issue was Fable-parked, #2710 ("late-bind module indices") landed
slices 0+1 of the same migration: the `scripts/prove-emit-identity.mjs`
byte-identity oracle and the `FuncHandle`/`GlobalHandle`/`TypeHandle`
vocabulary pinned onto the discriminated `Instr` arms
(`src/ir/types.ts`). #1916's original sketch (shared mutable `{index}`
cells mutated by shifters) is **rejected** in favour of #2710's stable
counter-minted handles + one `resolveLayout()` at serialization, for two
reasons grounded in prior findings:

1. **Mutable cells keep the class reachable** — every shifter must still
   know about every cell holder (the same "did you remember to chase this
   side-channel" discipline that produced the 7 regressions). Stable
   handles + late resolve delete the shifters instead of teaching them.
2. **#1899's implementation notes prove idx-keyed repair is unsound** —
   a numeric funcIdx is ambiguous across shifts (a freed slot gets reused
   by a different function), so identity must ride IN the instruction as
   a layout-independent value. That is exactly the #2710 handle.

The #1916 amendment's collision-free requirement is satisfied for the
handle itself (monotonic counter, never reused, never renumbered — no
name derivation). The registry-key collision class (name-keyed
`funcMap.get(name)` returning the wrong entry — #1983/#1989) is
orthogonal to index binding and stays tracked in those issues.

**Slice mapping (each ships green + byte-identical via
`prove-emit-identity`; #2710 slice numbers in parens):**

- **S1 (=2710 slice 2) — resolver seam, identity.** THIS SLICE.
  `src/emit/resolve-layout.ts` (`ModuleLayout` + identity `resolveLayout`)
  armed per-emit in `emitBinaryWithSourceMap` next to `valCtx`; every
  func/global reference serialization in `src/emit/binary.ts` now
  dereferences through it: `call`, `return_call`, `ref.func`,
  `global.{get,set}`, func/global export descriptors, element-segment
  function lists, `declaredFuncRefs`, start section. Proof: 1215
  (file,target) records — playground examples + 392-file test262 sample
  × {gc, standalone, wasi}, 992 real binaries — **byte-identical**.
  Late-shift class holds: issue-329/1677/1809/1839/1899/2191/2193/2918
  suites green (51 tests) + new `tests/issue-1916-symbolic-func-refs.test.ts`.
- **S2 (=2710 slice 3) — convert positional reads.** The ~94
  `mod.functions[idx - numImportFuncs]` reads + `idx - numImportFuncs`
  arithmetic become chokepoint accessors (registry-keyed); globals'
  `localGlobalIdx`/`nextModuleGlobalIdx` analogues audited. Enumerate by
  temporarily flipping the brand to `unique symbol` (tsc lists every
  violation), convert, keep byte-identity.
- **S3 (=2710 slice 4b/4c, func space — the heart of #1916).** Mint
  stable func handles at registration; `resolveLayout` computes the real
  permutation (imports in declaration order, then live defined funcs in
  array order post-DCE — reproduces today's layout byte-for-byte); DELETE
  the four func-index shifters (`shiftLateImportIndices`,
  `reconcileNativeStrFinalizeShift`, the `addStringImports` /
  `addUnionImports` inline shifters) + the `liveBodies`/
  `parentBodiesStack` reachability bookkeeping; dead-elim stops
  renumbering func refs (drops dead defs; layout skips dead handles).
  Full CI + merge_group (broad-impact — never a scoped sweep).
- **S4 (=2710 slice 4a/4d) — globals (`fixupModuleGlobalIndices` + ~25
  cached fields, the #2078 site), then types (DCE renumber through
  `resolveLayout`).** May land under #2710 directly.

Coordination note: #2710 is claim-held by `ttraenkler/sd-indexshift`
(2026-06-26, no active agent, no open PR). S1–S3 are being advanced
under #1916 by `ttraenkler/dev-1916f` with a cross-note in #2710's log;
the two issues share one mechanism and MUST NOT diverge.
