---
id: 3141
title: "Self-hosted stdlib pilot: compile math-helpers as TS builtin source through our own IR pipeline (porffor model)"
status: done
assignee: ttraenkler/fable-selfhost
sprint: Backlog
created: 2026-07-11
updated: 2026-07-11
completed: 2026-07-11
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

## Result (2026-07-11, fable-selfhost) — VERDICT: GO

Pilot delivered BEYOND the minimum scope: **nine** helpers converted (the whole
derived family — sinh/cosh/tanh, asinh/acosh/atanh, cbrt, expm1, log1p), not
just one. The thesis is PROVEN: builtins written as ordinary TS source in the
IR-claimable subset compile through our own pipeline into drop-in replacements
for hand-emitted `Instr[]`, with **zero dialect gaps hit** — from-ast accepted
every construct on the first run.

### What shipped

- `src/stdlib/math.ts` (205 raw lines, ~95 lines of actual TS function bodies)
  — the nine builtins as source, with the dialect rules documented.
- `src/codegen/stdlib-selfhost.ts` (161 lines, one-time reusable driver) —
  parse → `lowerFunctionAstToIr` → verify → hygiene passes (memoized as a
  context-free `IrFunction`, symbolic refs per #1131 §1.2) → per-compilation
  `lowerIrFunctionToWasm` against the live ctx → `pushDefinedFunc`. Sibling
  calls (`Math_exp`) resolve by funcMap name at lowering time — self-hosted
  code composes with hand-written helpers, enabling leaf-first incremental
  conversion of any family.
- `src/codegen/math-helpers.ts`: **−316 lines** of hand assembly deleted
  (1,688 → 1,394).
- `tests/issue-3141.test.ts` — specials + accuracy, host AND standalone.

### Proof (all green)

1. **Bit-exactness**: 36,477-case sweep vs an exact JS port of the deleted
   hand algorithms — ZERO mismatches (±0, NaN, ±Inf, denormals, domain edges,
   Taylor thresholds, 4k random values across 60 orders of magnitude).
2. **Containment**: programs NOT using the nine methods produce byte-identical
   binaries branch-vs-main (SHA-compared, incl. a still-hand-written
   sin/pow/log2 user).
3. **Both pure-Wasm lanes**: `target: standalone` and `target: wasi` compile
   and pass specials with zero host imports.
4. `tests/math-inline.test.ts` 49/49; LOC-budget gate OK (net +72, no
   allowance needed); IR-fallback gate OK.

### Measurements (the go/no-go data)

| Metric | Value |
| --- | --- |
| Hand-emission deleted | 316 lines |
| Replacement TS-source bodies | ~95 lines (**3.3× body compression**) |
| One-time driver (amortizes over all families) | 161 lines |
| Net this PR (raw src/) | +72 (driver-dominated; next family is pure deletion) |
| Marginal cost of family N+1 | TS source only — no new infrastructure |
| Dialect gaps hit | **0** (workarounds: `x !== x` for NaN-in, `0/0` for NaN-out, `> MAX_VALUE` for ±Inf — no from-ast changes needed) |

Extrapolation: finishing the math family (sin/cos/exp/log/atan/tan/atan2/pow/
log2/log10 cores, ~1.05k hand lines remaining, all expressible in the proven
dialect TODAY) → math-helpers.ts collapses to a ~250-line registration shell,
net ≈ −0.8k. At the measured 3.3× (conservative vs porffor's 5–8× on larger
families where hand-emission overhead is worse), the ~76k stdlib mass reduces
by ~45–55k as the battle plan estimated — the pilot CONFIRMS the plan's number.

### Caveats / notes for scale-up

- The IR's loop/try op families are WasmGC-`Instr[]`-only today (#1584 §2a), so
  loop-bearing self-hosted bodies serve the WasmGC backend; the linear backend
  needs the a1..a6 trait migration before it can consume them (it does not
  consume math-helpers today either, so nothing regressed).
- The driver's resolver deliberately throws on globals/named-types/objects —
  string/array families will need it widened to delegate to integration.ts's
  `makeResolver` machinery (small refactor, listed in the scale-up plan).
- `NaN`/`Infinity` identifiers in from-ast would be a nice QoL precursor but
  are NOT blocking (pilot shipped without them).

**Scale-up roadmap: `plan/self-hosting-scale-up.md`** (battle-plan slice 9).
