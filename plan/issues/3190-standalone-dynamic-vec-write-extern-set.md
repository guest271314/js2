---
id: 3190
title: "standalone: dynamic STORE to an any-typed array element is a no-op — __extern_set lacks a $__vec_base arm (write-side sibling of #3183)"
status: ready
created: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: member-assignment
goal: standalone
umbrella: 2860
sprint: current
horizon: l
related: [3183, 3179, 3169, 2186, 2860]
origin: "Found while implementing #3183 (the READ-side fix). #3183 made an any-typed vec enumerate for-in and answer string-key reads; this is the remaining WRITE face."
---

# #3190 — standalone: dynamic `arr[i] = v` on an any-typed array does not land (write-path vec arm missing in `__extern_set`)

## Problem (verified repros, all on main + after #3183)

When the receiver's STATIC type is `any`, a computed STORE `arr[i] = v` routes
through the dynamic `$Object` runtime via `__extern_set(obj, key, value)`. A
real array in standalone is a `__vec_<elemKind>` struct subtyping `$__vec_base`
(#2186), NOT a `$Object`. `__extern_set` has no `$__vec_base` arm, so the store
is silently dropped — the element is never written.

```ts
// A: literal vec, dynamic overwrite is a no-op
export function test(): number {
  var a: any = [0];
  a[0] = 42;
  return a["0"]; // ACTUAL 0 (the literal's original element), expected 42
}
```

```ts
// B: new Array() + dynamic fill — nothing lands, so for-in also yields nothing
export function test(): number {
  var a: any = new Array();
  a[0] = 1; a[1] = 2;
  let n = 0;
  for (var k in a) { n = n + 1; }
  return n; // ACTUAL 0, expected 2 (writes never landed → vec stays empty)
}
```

The READ side is already correct (#3183): reads of a **pre-populated** vec
(array literals with data, aliased typed-array locals) enumerate for-in and
answer string-key reads. Only the WRITE path is missing.

## Root cause

`__extern_set` (`src/codegen/object-runtime.ts`) unwraps the receiver to
`$Object` and returns early / no-ops when the receiver is not a `$Object`. A
`__vec_<k>` receiver is not a `$Object`, so:

1. an in-bounds overwrite (`a[0] = 42` on `[0]`) never mutates `data[0]`;
2. `new Array()` starts empty and cannot be grown through the dynamic path, so
   B never populates anything.

Two sub-problems, likely different difficulty:

- **In-bounds overwrite** (`a[i] = v`, `0 <= i < len`) — a `$__vec_base` arm
  that `array.set`s `data[i]` after coercing `v` to the carrier's element type.
  Complication: element-type polymorphism (each `__vec_<k>` has a different
  `data` element type and needs per-kind UNBOXING of the externref `value`),
  mirroring `fillExternGetIdxVecArms`'s per-carrier boxing on the read side — so
  this likely wants a finalize-fill (`fillExternSetIdxVecArms`) over every
  registered carrier, not a single inline arm.
- **Grow / `new Array()` append** (`a[len] = v` or `new Array()` then writes) —
  a WasmGC `array` is fixed-length, so growth needs the resizable-vec
  representation (spare-capacity `$Vec` / reallocation), which the dynamic
  path does not currently drive. This is the harder half and may need its own
  slice; the in-bounds overwrite can land first.

## Acceptance criteria

- Repro A returns 42 (in-bounds dynamic overwrite lands, per element kind).
- Ideally repro B returns 2 (dynamic grow) — may be split into a follow-up if
  the resizable representation is out of this slice's scope.
- Zero host-lane regressions (host imports own the write path; standalone-only
  arms, host bytes unchanged), zero standalone high-water regressions.

## Notes

- Read-side siblings for reference: `fillExternGetIdxVecArms` (#2190,
  per-carrier element read), `fillDynamicForinVecArms` (#3183, for-in /
  string-key read), `$__vec_base` length arm (#2186). The write arm is the
  mirror of the #2190 read fill.
- `__extern_set`'s signature and the coercion of `value` (externref) down to the
  carrier element kind is the crux — reuse the existing unbox helpers
  (`__unbox_number`, etc.) rather than adding parallel ones (anti-bloat).
