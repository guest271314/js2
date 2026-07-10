---
id: 2857
title: "IR: claim static methods under `extends` (class-method 6 → 5)"
status: done
completed: 2026-07-02
sprint: 69
created: 2026-06-30
updated: 2026-07-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: classes
goal: ir-full-coverage
parent: 2855
related: [1370, 3000]
---

# #2857 — IR: claim static methods under `extends` (class-method 6 → 5)

Child of the IR front-end migration epic **#2855**. Continues the class-member
adoption that **#1370 started**.

## Re-scope note (2026-07-02)

This issue was originally framed "drive the whole `class-method` bucket to
zero" and mis-sized `M`. A measure-first scoping pass (per-member
`planIrCompilation(..., trackFallbacks)` probe on the sole corpus file
`website/playground/examples/js/classes.ts`) found the 6 `class-method`
fallbacks split into **one cleanly-bounded win** and a **genuinely-XL
remainder**:

| Member        | Reason         | Substrate                                      |
| ------------- | -------------- | ---------------------------------------------- |
| `Dog_kingdom` | `class-method` | **static method under `extends`** ← this slice |
| `Animal_name` | `class-method` | accessor + private field                       |
| `Animal_age`  | `class-method` | accessor + private field                       |
| `Dog_breed`   | `class-method` | accessor + private field                       |
| `Dog_new`     | `class-method` | inheritance: `super(...)` ctor                 |
| `Dog_speak`   | `class-method` | inheritance: `super.method()`                  |

`#2857` was therefore narrowed to just the static-method slice (6 → 5). The
remaining XL surface (private-field IR support + accessor lowering +
inheritance/`super`) was split out to **#3000**.

## Problem (this slice)

A `static` method compiles to an ordinary function: no `self` injection, no
dependency on the parent-prefixed instance layout. So a static method whose body
does not reference `super` is exactly as IR-claimable as the same static in a
flat class — the parent-less `Animal.kingdom()` was **already** claimed by the
selector. But the selector's `hasParent` gate (`src/ir/select.ts`) rejected
**every** member of a class with `extends` as `class-method`, so the identical
`Dog.kingdom()` (static-in-subclass) stayed on the legacy path unnecessarily.

## Fix

`src/ir/select.ts` — in the class-member walk, carve a `hasParent` exception for
a `static` method with **no `super`** in its body: let it fall through to the
normal `whyNotIrClaimable` gate instead of the blanket `class-method` reject
(added a small `referencesSuper` subtree scan). This claims `Dog_kingdom` into
`classMembers` exactly as `Animal_kingdom` is claimed today.

## Byte-inertness

Class-member selector claims are **informational** (Phase B integration only
patches instance methods of flat classes — `src/ir/integration.ts:294` skips
`extends` classes and L310 skips statics; `computeIrFirstSkipSet` in
`src/codegen/index.ts` only skips top-level FunctionDeclaration bodies, never
class members). The legacy path still emits every class-member body. Verified:
`classes.ts` compiles to a **bit-identical** wasm binary before and after the
change (sha256 `544922265d9c…`, 3385 bytes) — only the fallback metric moves.

## Acceptance criteria (this slice) — all met

1. ✅ `class-method` count in `scripts/ir-fallback-baseline.json`: 6 → **5**
   (ratcheted via `check:ir-fallbacks --update-on-decrease`).
2. ✅ `Dog_kingdom` claimed by the selector; `Animal_kingdom` still claimed.
3. ✅ A `super`-using static (`Dog.describe(){ super.kingdom() }`) is NOT
   claimed — stays `class-method` for the #3000 inheritance slice.
4. ✅ Instance members / constructor of an `extends` class still `class-method`.
5. ✅ `classes.ts` wasm output unchanged (byte-inert); new regression test
   (`tests/issue-2857.test.ts`) asserts the selector split + runtime parity.

## Follow-up

The remaining `class-method: 5` + the two co-located class-member
`body-shape-rejected` attributions (`Animal_new`, `Animal_speak`) are owned by
**#3000** (private fields, accessors, inheritance/`super`) — the XL remainder,
gated on private-field IR support. `"class-method"` joins `STRICT_IR_REASONS`
only once #3000 reaches zero.

## Files touched

- `src/ir/select.ts` — `referencesSuper` helper + `hasParent` static exception.
- `scripts/ir-fallback-baseline.json` — `class-method` 6 → 5.
- `tests/issue-2857.test.ts` — regression test (selector split + parity).
