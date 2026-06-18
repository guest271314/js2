---
id: 2169b
title: "Standalone Array.from(<native array iterator>) — __iterator driver struct.new index desync (invalid struct index)"
status: in-progress
sprint: 64
created: 2026-06-18
updated: 2026-06-18
assignee: ttraenkler/sdev-iter
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: iterators-collections
goal: standalone-mode
parent: 2169
---

# Standalone `Array.from(<native array iterator>)` — `__iterator` struct.new index desync

## Problem

On standalone (`--target wasi`), `Array.from(x)` over **any native array
iterator** VALIDATE-FAILs:

```ts
Array.from([10, 20].values()); // VFAIL: __iterator failed: invalid struct index: 34
Array.from([10, 20].keys()); // VFAIL: invalid struct index: 34
Array.from([10, 20].entries()); // VFAIL: invalid struct index: 37
Array.from([10, 20]); // OK (plain array — does not go through __iterator)
Array.from(new Set([7])); // separate VFAIL: struct.new need 4 got 2 (Set path — out of scope, #2162)
```

`[...arr.values()]` array-spread is fine (#2162b path); only the `Array.from`
consumer routes the canonical externref `$Vec` through the native `__iterator`
driver, which is where the break is. **Not entries-specific** — `.values()` /
`.keys()` fail identically (the index differs only because entries registers
extra `$ObjVec` types).

## Root cause (fully traced, reproducible)

The `__iterator(obj)` native body (`src/codegen/iterator-native.ts`
`buildIteratorBody`) builds `$IterRec` via `struct.new <iterRecTypeIdx>`, nested
inside the `ref.test $Vec` `if`/`then` + `else` arms. The emitted body's
`struct.new` operand **desyncs from the `$__IterRec` type-def's final index**:

Single-compile trace (`Array.from(a.values())`):

- **Registration** (`getOrRegisterIterRecType`): `$__IterRec` pushed at type idx
  **46**; `buildIteratorBody` emits `struct.new 46` (×2, in the then/else arms).
- **DCE** (`eliminateDeadImports`, the type-DCE half): builds `tR` mapping
  46→**40**; `surv` places `$__IterRec` at pos **40**. Body remapped to
  `struct.new 40`. **Internally consistent at this point (40 / 40).**
- **Final emitted module**: `$__IterRec` type-def at idx **32**, but the
  `__iterator` body emits `struct.new 34` → V8 `invalid struct index: 34` (type
  34 is `$__box_boolean_struct`, a 1-field struct; the body pushes 4 fields).

So a **SECOND type renumbering happens AFTER DCE** (between DCE-end and binary
emit) that moves the `$__IterRec` type-def 40→32 (−8) but the body's nested
`struct.new` 40→34 (−6). The −8/−6 split = a renumber that drops 8 dead types
before `$__IterRec` but only re-remaps the body by −6 — i.e. the second
renumbering does NOT consistently re-remap the `__iterator` body's nested
`struct.new` operands. (DCE itself runs exactly once and is consistent; the
desync is downstream of it.)

**Pass-bisect results (env-gating each finalize-tail pass):** disabling
`peepholeOptimize` alone, `repairStructTypeMismatches` alone, and BOTH together
ALL still VFAIL `invalid struct index: 34` — so the body's `struct.new` operand
is **already wrong (34) before either pass runs**, i.e. the desync is produced
**inside `eliminateDeadImports` (DCE) itself**, not downstream. (An earlier
single-snapshot read suggested DCE left it consistent at 40/40, but the
pass-gating disproves a post-DCE culprit — the inconsistency is in DCE's remap of
the `__iterator` body vs the `$__IterRec` type-def. The `tR` remap is applied to
both `mod.types` (line 353) and each body via `remapTypeIdxInBody` (359), so the
divergence implies the `__iterator` body the remap walks is NOT the same body
that ships — a likely body-aliasing / savedBody-swap issue where the iterator
carrier body was rebuilt at finalize-fill into a NEW array that DCE's
walk-and-mutate either missed or double-applied.) Next step: log `tR.get(46)`
AND the identity (object ref) of the `__iterator` function's body array at DCE
entry vs at emit — confirm they're the same array; if the finalize USER-arm fill
(`fillNativeIteratorUserArms`) or the vec-only registration left a stale body
reference, DCE remaps one copy while emit serializes the other.

This is the [[reference_subview_type_idx_stability]] /
[[reference_no_rebuild_helper_body_at_finalize]] family — a shared-helper
type-index-stability invariant, NOT a one-arm fix. Blast radius: any helper body
with a `struct.new`/`struct.get` whose type-def survives a post-DCE renumber.

## Scope

In scope: `Array.from(<native array iterator>)` (`.values()`/`.keys()`/
`.entries()`). Out of scope: `Array.from(new Set(...))` (Set producer, separate
`struct.new need 4 got 2` bug → #2162 Map/Set lane); the Map-iterator producer
(`[...m.entries()]`/bare `[...map]`, #2162 / task #8).

## Regression-guard strategy (REQUIRED, before AND after)

- WAT-diff a plain `Array.from([1,2])` (the non-iterator path) byte-identical.
- Full local iterator/spread/destructure suites (issue-2169-_, issue-42-_,
  for-of-\*, basic/array-rest-destructuring).
- `pnpm run check:ir-fallbacks` OK. Hard floor-gate the standalone HW shard.
- Helpers BY NAME (#2191). No funcIdx captured before a later import-adding phase.

## Source

Root-caused 2026-06-18 (sdev-iter), filed as a distinct issue from the landed
#2169 native-array-iterator slice (whose dev-typed claim is stale: no remote
branch, no PR). This is a separate `__iterator`-driver type-index desync, not the
#2169 producer work.
