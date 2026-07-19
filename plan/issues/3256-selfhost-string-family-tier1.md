---
id: 3256
title: "Self-host stdlib: convert native-strings.ts hand-emitted Instr[] to TS (Tier-1 resolver-widening)"
status: done
assignee: ttraenkler/sendev-3256
completed: 2026-07-16
pr: 3119
sprint: 72
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

## Result (2026-07-16, sendev-3256)

**Landed:** Tier-1 resolver widening + Precursor A + NINE helpers self-hosted
(`__sh_str_isWs`, `__str_trimStart`, `__str_trimEnd`, `__str_trim`,
`__str_startsWith`, `__str_endsWith`, `__str_repeat`, `__str_padStart`,
`__str_padEnd`). ~795 hand `Instr[]` lines deleted → ~135 TS-source lines
(≈6× body compression); **net −206 src LOC** including the one-time driver
widening (+204, amortizes over Tier-2/3). Godfile baseline ratcheted
(`scripts/godfile-profile-baseline.json`, gate OK).

### What was built (and WHY it diverges from the pre-scoped sketch)

- **Driver widening** (`src/codegen/stdlib-selfhost.ts`): `resolveFunc` gets
  makeResolver's name-fallback (funcMap → post-shift `ctx.mod.functions` scan
  → `nativeStrHelpers`) + on-demand `__str_charCodeAt` materialization;
  `resolveString()`; `resolveType` name-scan; `emitString{Const,Concat,
  Equals,Len}` (native-mode-only, loud errors elsewhere). `computeStringBackend`
  was NOT exported (the sketch's option b): the driver resolves helper indices
  by post-shift name-scan at its own emission instant, which is the same
  mechanism computeStringBackend uses and avoids coupling to integration.ts's
  Phase-3 lifecycle. Later import shifts are repaired by the existing
  `reconcileNativeStrFinalizeShift` (all bodies emitted in the
  `nativeStrHelperImportBase` regime are walked uniformly — IR-lowered ones
  included).
- **Build-time dialect** (`dialect: "native-strings"` on `SelfHostedFuncDef`):
  from-ast needs a resolver for string METHOD syntax; the driver installs a
  context-free `stringMethodPlan` subset (charCodeAt, substring only — unknown
  methods stay loud errors, preserving the pilot's scope-guard) plus the live
  ctx's `resolveString()`. **Key discovery:** mutated string `let`s bind as
  SLOTS whose Wasm-local type is the ctx-bound `(ref $AnyString)` — so string
  defs must NOT set `memoKey` (rebuilt per compilation, bounded to once by the
  funcMap early-return; guarded by an assertion in `buildSelfHostedIr`).
- **Dialect limits found:** params are NOT reassignable in the IR subset
  (flatten result binds to a fresh `let`); native `stringMethodPlan` demotes
  indexOf/includes/startsWith/endsWith method calls, so self-hosted bodies use
  charCodeAt scan loops instead of delegating.
- **ABI preservation:** legacy i32 position/count params kept via 4-6-instr
  hand thunks (`f64.convert_i32_s` widen + forward) — the #3159
  `__timsort_<k>` move — because from-ast's stringMethodPlan and the
  string-ops.ts arms bake the i32 ABI for `__str_*` names. Trim family ABIs
  (`(str) -> str`) needed no thunks.
- **O(n²) hazard avoided:** `__str_charCodeAt` re-flattens its receiver per
  call; scan bodies flatten params ONCE at entry via `__str_flatten` declared
  as a `(string) -> string` callee (its real `(ref $NativeString)` result is a
  Wasm subtype of the declared `(ref $AnyString)` — validates fine).
- **Overflow parity for repeat/pad doubling:** the rope-doubling loop also
  exits when `out.length` stops being positive (i32 length wrap past 2^31);
  the final `.substring()` then flattens and hits the same
  `array.new_default` trap the hand kernel's wrapped `i32.mul` allocation hit
  — same observable failure class, no unbounded loop.

### Validation

- `tests/issue-3256.test.ts` — 12 tests, standalone + wasi lanes, in-wasm
  assertions vs a JS oracle (empty/unicode-ws/surrogates/cons-rope inputs,
  #2875 position clamps, 10k-char repeat). The host lane is byte-identical
  (below), so JS semantics = host-lane results by construction (A/B).
- Containment probe (`.tmp/probe-3256-containment.mts`): host-mode-with-strings
  main vs branch **SHA-identical**. Native lanes have NO non-user —
  `ensureNativeStringHelpers` runs for every standalone module on main already
  (verified: a pure-math standalone module contains `__str_trimStart` on main)
  — so native containment is not observable; equivalence gates carry it.
  Unoptimized standalone binary +1.6KB (IR-lowered bodies + thunks; wasm-opt
  DCEs unused helpers in optimized builds).
- Scoped equivalence: the 14 equivalence files that showed failures fail
  IDENTICALLY on main (28/28 same test names — pre-existing, e.g.
  issue-2166 standalone JSON toJSON cluster); zero new failures.
- `pnpm run check:godfiles` OK after `--update`.

**Unblocks #3257 (Tier-2, array-methods.ts).**
