---
id: 3257
title: "Self-host stdlib: convert array-methods.ts hand-emitted Instr[] to TS (Tier-2)"
status: in-progress
assignee: ttraenkler/sendev-3256
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

## Corrected scoping (2026-07-16, sendev-3256 — pre-implementation recon)

**The issue premise needs one correction:** `array-methods.ts` registers ZERO
discrete runtime helper functions (verified: 0 `pushDefinedFunc`/
`mintDefinedFunc`, 211 `allocLocal`s) — every `compileArray*` is a call-site
INLINE emitter. There are no "discrete fixed-ABI array runtime helpers" to
convert; Tier-2 must MINT them, following the `ensureTimsortHelper` template
already in this file's dispatch (array-methods.ts:6533 — thunk at call site +
self-hosted kernel, #3159).

**Net-negative seams** (per `reference_selfhost_netnegative_needs_full_elemkind_dialect`
— an inline arm only deletes if ALL its element kinds route to kernels):

1. **Move-only ops** — `reverse`, `fill`, `copyWithin` (+ `toReversed`/`with`
   if time allows): never inspect element VALUES, so ONE elemKind-generic TS
   kernel template instantiated per element ValType (f64/i32/externref/
   `ref_<typeIdx>`, keyed like `getOrRegisterVecType`'s elemKind) covers the
   WHOLE dialect → full inline-arm deletion. Needs `ensureArrayIntrinsics`
   (timsort.ts, currently private) lifted + generalized from k∈{f64,i32} to
   arbitrary (elemKindKey, elementValType). `copyWithin` reduces to clamps +
   one `__arri_copy_<k>` (array.copy is overlap-safe).
2. **Numeric equality scans** — `indexOf`/`lastIndexOf`/`includes` f64/i32
   arms via `__arri_get_<k>`; SameValueZero NaN arm is TS-expressible
   (`t !== t && x !== x`). externref arms MAY also convert (EXT params +
   `__extern_strict_eq`/`__extern_same_value_zero` as declared callees, the
   #3160 pattern); `ref_<typeIdx>`-element arms need extern.convert_any (not
   in dialect) — keep inline unless measured net-negative.

**Driver Tier-2 widening** (stdlib-selfhost.ts): add the
`__vec_elem_set_<vecTypeIdx>` on-demand resolveFunc arm (mirror
integration.ts:1306) per this issue's scope; vec-struct types flow as
ctx-bound `ref_null { typeIdx }` paramTypes (the #3161 path — no memoKey),
so no new resolveType machinery is needed beyond Tier-1's name-scan.

**Emission-window difference vs #3256:** kernels mint ON DEMAND at call-site
compile time (like `ensureTimsortHelper`), NOT inside a finalize window —
append-only defined funcs are safe there (timsort precedent), but any host
IMPORT callee (`__host_eq`) must be `ensureLateImport`'d BEFORE kernel
lowering to avoid mid-body funcIdx shifts.

**Out of scope confirmed by recon:** `compileArrayLikePrototypeCall`
(host-import iteration, borrow file), `join*` (string dialect), callback HOFs
(closure bridge), `splice`/comparator-`sort`/`defaultToStringSort` (vec
mutation + string dialect).
