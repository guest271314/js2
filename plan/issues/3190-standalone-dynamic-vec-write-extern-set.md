---
id: 3190
title: "standalone: dynamic STORE to an any-typed array element is a no-op — __extern_set lacks a $__vec_base arm (write-side sibling of #3183)"
status: done
assignee: ttraenkler/dev-vec-arms
completed: 2026-07-12
created: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: member-assignment
goal: standalone
umbrella: 2860
sprint: 71
horizon: l
related: [3183, 3179, 3169, 2186, 2860]
origin: "Found while implementing #3183 (the READ-side fix). #3183 made an any-typed vec enumerate for-in and answer string-key reads; this is the remaining WRITE face."
# The `$__vec_base` write fill is new native-runtime codegen that belongs in
# object-runtime.ts (its read sibling `fillExternGetIdxVecArms` lives there); the
# index.ts delta is just the import + one finalize call. Intended feature growth.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
# The write arm REUSES the engine's `__unbox_number` (ToNumber for both the index
# key and per-carrier value coercion) — it does NOT hand-roll a fresh ToNumber
# matrix; the gate counts the added call sites, so grant the allowance.
coercion-sites-allow:
  - src/codegen/object-runtime.ts
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

## Resolution (2026-07-12) — IN-BOUNDS OVERWRITE half

Implemented as `fillExternSetVecArms` (`src/codegen/object-runtime.ts`), wired
into the finalize sequence in `src/codegen/index.ts` right after
`fillExternGetIdxVecArms` (its read sibling). It PREPENDS a self-contained
`ref.test $__vec_base`-guarded arm into `__extern_set` (the `fillExternGetErrorProps`
splice discipline — append locals, never renumber; falls through untouched for
non-vec receivers so host / non-vec output is byte-identical):
`n = __unbox_number(key)` (ToNumber; skip on NaN) → `i = trunc_sat(n)` →
in-bounds `0 <= i < len` via `$__vec_base` → per-carrier `ref.test <carrier>` →
`array.set(data, i, unbox(value))`. Value coercion reuses the engine's
`__unbox_number` via the new `unboxExternrefToVecElement` (the inverse of the
read fill's `boxVecElementToExternref`): f64 / numeric-i32 / externref carriers;
string/ref/bool/f32/i64 carriers have no trap-free unbox and stay a silent no-op
(same as before), so the store is scoped to the trap-free numeric + externref
carriers (the dominant `number[]`/`any[]` case).

Verified standalone (zero host imports, `tests/issue-3190.test.ts`, 8 cases;
writes observed via NUMERIC index reads which are vec-aware since #2190,
independent of #3183's for-in/string-key read fill):
- in-bounds overwrite lands (number[] → 42; overwrite-all sum → 6); index from
  an any var → 77; non-integer value coerced (3.5 → *2 = 7); externref (any[])
  carrier → 9.
- OOB / negative-index store → silent no-op, no trap, existing data intact.
- plain any-typed object element store unchanged.

`quality` cheap gates green locally (loc-budget + coercion-sites allowances
granted above; ir-fallbacks / any-box / stack-balance / codegen-fallbacks OK).

### Deferred (documented, not this PR): GROWTH
`var a: any = new Array(); a[0] = 1` and `a[len] = v` (grow) still no-op — a
WasmGC `array` is fixed-length, so growth needs the resizable-vec representation
which the dynamic path does not drive. Tracked here for a follow-up slice; the
in-bounds overwrite (this PR) is the tractable, high-value half. `new Array()`
starts empty, so its for-in/read also yields nothing until growth lands.
