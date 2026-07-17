---
id: 2370
title: "[ARCH] DCE remapTypeIdxInBody is non-idempotent — any aliased helper body double-remaps (latent miscompile)"
status: ready
sprint: Backlog
created: 2026-06-18
assignee: ""
priority: medium
feasibility: hard
model: fable
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: codegen-infra
goal: standalone-mode
---

# DCE `remapTypeIdxInBody` is non-idempotent — aliased bodies double-remap

## Problem (latent landmine)

`eliminateDeadImports` (`src/codegen/dead-elimination.ts`) removes dead types and
remaps surviving type indices. It mutates each function body **in place** via
`remapTypeIdxInBody(func.body, tR)` (`walkInstructions` + `a.typeIdx = tR.get(...)`).

The remap is **non-idempotent**: it rewrites `a.typeIdx` to `tR.get(a.typeIdx)`
without marking the instruction as already-mapped. When the remap table `tR`
contains a CHAIN — e.g. `46→40` AND `40→34` (common: both 46 and 40 are live old
indices that compact to different new positions) — and an instruction object is
reachable **more than once** in the body walk, the rewrite composes:
`46 → 40 → 34`. The instruction ends at the wrong type index while the type-def
(remapped once via `surv.map(remapTD)`, which reads the original `td`) lands
correctly. Result: `invalid struct index` / wrong-type miscompile.

**Confirmed instance (#2169b):** `buildIteratorBody` aliased one `vecArm`
`Instr[]` into BOTH the `if`'s `then` and `else` (`elseArm = vecArm` on the
vec-only path), so its shared `struct.new $__IterRec` was walked twice and
double-remapped `46→40→34` (34 = `$__box_boolean_struct`), breaking
`Array.from(<native iterator>)`. That instance was fixed _locally_ (de-alias the
arm — distinct instruction objects per branch). But the DCE pass itself is still
non-idempotent, so **any** helper whose body aliases an instruction object across
two reachable positions is a latent double-remap waiting to trigger whenever the
type-table shape produces a chained `tR`.

## Why this is architect-scale

The durable fix changes the **global DCE remap contract**, not one helper:
make `remapTypeIdxInBody` idempotent so a chained `tR` + any aliasing is safe.
That touches every body the pass rewrites. Options:

1. **Idempotent remap (recommended):** build `tR` so it is NOT chained — i.e.
   compute the new index for each old index directly against the _original_
   numbering (a single old→new map with no transitive composition), and/or apply
   the map by **rebuilding** each instruction's `typeIdx` from a snapshot of the
   pre-remap value rather than reading the possibly-already-mutated field. Since
   `tR` is built old→new in one pass (`surv` enumeration), the chain only bites
   when an instruction is VISITED twice — so the minimal robust fix is to ensure
   `walkInstructions` visits each instruction object at most once, OR to guard the
   mutation (`if (!instr.__remapped) { instr.typeIdx = tR.get(...); instr.__remapped = true; }`)
   and clear the flag after. Prefer a clean "snapshot-then-write" that is immune
   to aliasing.
2. **Forbid body aliasing (defense-in-depth):** a dev-time invariant check that no
   two reachable positions share an `Instr` object. Catches the class at its
   source but doesn't fix the pass.

## Acceptance

- A repro where a helper body aliases a `struct.new` across two arms with a
  chained `tR` no longer miscompiles (add a synthetic test that constructs such a
  body, or re-introduce the #2169b alias and assert it stays valid post-fix).
- Full equivalence suite + standalone HW floor green (the pass rewrites every
  body — broad blast radius).
- No funcIdx/type-idx churn regressions ([[reference_no_rebuild_helper_body_at_finalize]]).

## Source

Root-caused 2026-06-18 (sdev-iter) while fixing #2169b's `__iterator` aliasing.
The localized #2169b fix landed separately; this is the durable global-invariant
follow-on, routed to architect per tech-lead direction.

---

## Implementation Plan (fable-arch, 2026-07-12 — RE-GROUNDED: most of this landed; one hole remains)

> Verified against `upstream/main @ 31b1970cf`. **The recommended fix
> (option 1) has since LANDED**: `remapFuncIdxInBody` and
> `remapTypeIdxInBody` (`src/codegen/dead-elimination.ts:150-199`) now carry
> the **#1302 WeakSet double-remap guard** (each `Instr` object remapped at
> most once per call), plus the **#2564 blockType-aliasing guard** (the
> `seen` set also keys shared `blockType` objects, :190-198). The #2169b
> intra-body aliasing class is fixed at the sink. What remains is ONE
> residual hole + the defense-in-depth check.

### Root cause of the residual

The `seen` WeakSet is **scoped per remapper CALL**, but `eliminateDeadImports`
invokes the remappers once per body:

- `dead-elimination.ts:410-412` — per-function loop:
  `remapFuncIdxInBody(func.body, fR)` / `remapTypeIdxInBody(func.body, tR)`
- `:459-460` — per-element-segment `el.offset`
- `:474-475` — per-global `g.init`

An `Instr` object aliased across **two different bodies** (one shared
helper `Instr[]` template spliced into two functions, or into a function
body and a global init) passes each call's fresh WeakSet and gets
chain-remapped once **per body** — the exact `46→40→34` composition the
issue describes, just at inter-body instead of intra-body scope. Same
latent-landmine profile: silent until the type table produces a chained
`tR` AND a producer shares a template across bodies (both have happened
independently — #2169b, #1302's DataView case, #2564's tag-cascade).

### Changes

**File: `src/codegen/dead-elimination.ts`**

1. Thread one pass-scoped guard through all remap calls. Both remappers are
   module-private (no external callers — verified by grep), so change the
   signatures additively:

   ```ts
   function remapFuncIdxInBody(body: Instr[], remap: Map<number, number>, seen: WeakSet<object>): void;
   function remapTypeIdxInBody(body: Instr[], remap: Map<number, number>, seen: WeakSet<object>): void;
   ```

   Delete the local `const seen = new WeakSet<object>()` in each (:151,
   :166). In `eliminateDeadImports`, create **two** pass-scoped sets before
   Phase 5 — `const seenF = new WeakSet<object>(); const seenT = new
WeakSet<object>();` — and pass `seenF` to every `remapFuncIdxInBody`
   call (:411, :459, :474) and `seenT` to every `remapTypeIdxInBody` call
   (:412, :460, :475). Two sets, not one: a given instruction carries BOTH
   a `funcIdx` and a `typeIdx`-family operand in some ops (`call_indirect`),
   and the func- and type-remaps must EACH apply exactly once to it.

2. **Defense-in-depth aliasing detector (option 2, debug-gated).** New
   function `assertNoCrossBodyAliasing(mod)` walking every body
   (`func.body`, `g.init`, `el.offset`) with a module-scoped WeakSet and
   throwing on the first `Instr` object reachable from two positions,
   naming both containers. Gate behind `process.env.JS2WASM_DEBUG_DCE_ALIAS`
   and call it at the top of `eliminateDeadImports`; enable the env var in
   the vitest setup for the equivalence suite so producers that reintroduce
   aliasing fail loudly in CI while production compiles pay zero cost.
   (Producers are still ENCOURAGED not to alias — the guard makes remap
   correct, not aliasing good style; see
   `reference_shared_instr_object_dce_double_remap`.)

### What NOT to do

- Do not switch to snapshot-copies of every body (`structuredClone`-style) —
  the pass is on the hot path for every compile and the WeakSet guard is
  already O(1) per instruction.
- Do not "fix" this by rebuilding helper bodies at finalize
  ([[reference_no_rebuild_helper_body_at_finalize]]).
- Long-term this whole remap regime is subsumed by #3029-S4/A7 + #2710
  slice 4d (DCE marks dead, `finalize()` skips — nothing renumbers
  instructions). This fix is the cheap interim hardening, not a competing
  design; do not expand it.

### Edge cases

- `blockType` objects shared across bodies: covered automatically once
  `seenT` is pass-scoped (the blockType guard at :190 uses the same set).
- Chained `fR` (function-index chains) has the identical exposure — that is
  why `seenF` is threaded too, not just the type set.
- Re-running `eliminateDeadImports` twice on one module stays safe: each
  invocation computes a fresh `tR`/`fR` against current indices, and fresh
  pass-scoped sets are correct there (the guard must NOT persist across
  passes).

### Validation

- **Synthetic regression test** (acceptance criterion 1): build a
  `WasmModule` fixture with a shared `struct.new` Instr object spliced into
  TWO function bodies plus a type table shaped to give a chained `tR`
  (e.g. dead types at indices between two live ones so `46→40` and `40→34`
  both appear); run `eliminateDeadImports`; assert both occurrences land on
  the single-hop target. Add as `tests/issue-2370.test.ts` — unit-level,
  no compiler run needed.
- `node scripts/prove-emit-identity.mjs` — expected **byte-identical** on
  the 39-target corpus (no current producer is known to alias cross-body).
  If any hash CHANGES, that is a latent miscompile surfacing — diff the WAT
  and record it here; do not blindly rebaseline.
- Equivalence suite + full merge_group (the pass rewrites every body —
  broad blast radius, per the original acceptance note).

### Classification

**Fable-executable-now**, S-sized (mechanical threading + one test + one
debug walker). No dependencies.
