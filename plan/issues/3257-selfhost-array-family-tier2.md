---
id: 3257
title: "Self-host stdlib: convert array-methods.ts hand-emitted Instr[] to TS (Tier-2)"
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
depends_on: [3256]
related: [3141, 3256]
origin: "sprint-71 bloat audit — array-methods.ts = 10.2k LOC / 2,128 hand-emitted Instr[] sites"
---

# #3257 — Self-host the `array-methods.ts` family (Tier-2)

## Problem

`src/codegen/array-methods.ts` (10.2k LOC, ~2,128 hand-emitted `Instr[]`
sites) is the second-largest self-host bloat lever. Depends on the Tier-1
string groundwork (#3256) landing first.

## Scope (Tier-2, per plan/self-hosting-scale-up.md)

Extend the driver resolver with **VEC_ELEM_SET on-demand + vec `resolveType`**
(Tier-2), then convert the discrete fixed-ABI array runtime helpers (the
type-restricted, pure, fixed-ABI ones first per the self-host net-negative rule —
see `reference_selfhost_netnegative_needs_full_elemkind_dialect`). Convert only
the units whose element-kind dialect is fully covered; leave heterogeneous /
any-elem helpers for the object tier.

## Acceptance

- Tier-2 vec resolver support lands; the type-restricted array helpers self-hosted
  (hand `Instr[]` deleted), net −LOC.
- A/B equivalence + containment SHA; both pure-Wasm lanes zero host imports.
- Caveat check: the IR loop/try op families are WasmGC-`Instr[]`-only today
  (#1584 §2a) — loop-bearing self-hosted bodies serve the WasmGC backend; linear
  backend needs the a1..a6 trait migration first (it doesn't consume array-methods
  today either, so nothing regresses).

## Measurement (the profiler is this issue's progress meter)

Use the god-file profiler from #3259 as the acceptance instrument:

- **Before/after:** `pnpm run profile:godfiles` — `array-methods.ts` is the
  target; the tracked `hand-emitted-runtime` blocks this tier shrinks include
  `compileArrayLikePrototypeCall` (1,100 LOC, d≈0.21) and the per-method helpers
  (`compileArrayIncludes` d≈0.31, `compileArrayLastIndexOf` d≈0.32, …). Record
  the per-helper LOC delta here and in `plan/self-hosting-scale-up.md`.
- **Landing proof:** after each conversion, `node scripts/profile-godfiles.mjs
  --update` and commit `scripts/godfile-profile-baseline.json` so
  `pnpm run check:godfiles` ratchets down (fails on regrowth).
- Shape context: `plan/log/3259-bloat-quickwins-report.md`.

## Non-goals

- Object-family / any-elem helpers (Tier-3, #3258).
