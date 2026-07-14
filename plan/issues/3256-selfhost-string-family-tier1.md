---
id: 3256
title: "Self-host stdlib: convert native-strings.ts hand-emitted Instr[] to TS (Tier-1 resolver-widening)"
status: ready
sprint: current
priority: high
horizon: xl
feasibility: hard
task_type: refactor
area: codegen, stdlib, ir
language_feature: compiler-internals
goal: ir-full-coverage
created: 2026-07-14
related: [3141, 3226, 3204]
origin: "sprint-71 bloat audit — native-strings.ts = 7.5k LOC / 2,953 hand-emitted Instr[] sites"
---

# #3256 — Self-host the `native-strings.ts` family (Tier-1)

## Problem

`src/codegen/native-strings.ts` (7.5k LOC, ~2,953 hand-emitted `Instr[]`
sites) is the largest bloat lever after Math. The #3141 pilot proved the
self-host model (Math family: −390 LOC, bit-exact) and #3226 confirmed no
dialect gaps for pure-f64. Strings are the next family per the scale-up plan.

## Blocker / groundwork (Tier-1, do first)

The self-host driver's resolver (`stdlib-selfhost.ts:243`) throws on
globals/named-types/objects. opus-selfhost2 scoped a **tiered purpose-built
widening** (see `plan/self-hosting-scale-up.md`): Tier-1 = strings —
(a) widen `resolveFunc` to add makeResolver's name-fallback + on-demand
string-helper materialization; (b) `resolveString` via exporting
`computeStringBackend(ctx)`; (c) `resolveType` for the string struct. NO
object/closure/vec registries needed. Precursor A: declare `__str_charCodeAt`-
style callee sigs.

## Scope

1. Land the Tier-1 resolver widening + Precursor A.
2. Convert the SMALLEST fixed-ABI leaf `__str_*` helper first (opus-selfhost2's
   pick: `__str_repeat` or `__str_startsWith`) to `src/stdlib/` TS, proving the
   path end-to-end — MEASURE net LOC + containment before going wide.
3. Then convert the rest of the discrete `__str_*` runtime helpers
   (indexOf/padStart/slice/includes/…).

## Acceptance

- Tier-1 resolver widening lands; ≥1 `__str_*` helper self-hosted (hand `Instr[]`
  deleted), net −LOC.
- Validation: A/B equivalence (non-numeric → equivalence, not bit-exact-sweep) +
  containment SHA (non-users byte-identical). Both pure-Wasm lanes zero host imports.
- Update `plan/self-hosting-scale-up.md` with the measured per-helper compression.

## Measurement (the profiler is this issue's progress meter)

Use the god-file profiler from #3259 as the acceptance instrument, not eyeballed
LOC:

- **Before/after:** `pnpm run profile:godfiles` — `native-strings.ts` is the
  target; its `ensureNativeStringHelpers` (baseline 4,844 LOC, emission-density
  d≈0.46, classified `hand-emitted-runtime`) is the block this tier shrinks.
  Record the LOC delta per converted helper here and in
  `plan/self-hosting-scale-up.md`.
- **Landing proof:** after each conversion, refresh the tracked baseline —
  `node scripts/profile-godfiles.mjs --update` and commit
  `scripts/godfile-profile-baseline.json` — so the `pnpm run check:godfiles`
  gate ratchets down (it fails on regrowth). A shrink that isn't reflected in the
  baseline isn't banked.
- Shape context: report `plan/log/3259-bloat-quickwins-report.md` (32,272 LOC of
  `hand-emitted-runtime` across the god-files → this self-host track).

## Non-goals

- No object/array family (Tier-2/3, separate issues #3257/#3258).
