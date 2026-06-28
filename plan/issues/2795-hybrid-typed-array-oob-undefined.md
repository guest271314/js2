---
id: 2795
title: "Hybrid Row 9: typed-array element OOB → undefined (call-site policy, shared helper untouched)"
status: in-progress
assignee: ttraenkler/sendev-taoob
sprint: current
created: 2026-06-28
updated: 2026-06-28
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: typed-array
goal: correctness
related: [2760, 2766, 2785, 2792, 2593, 2762]
---

# #2795 — typed-array element OOB read → `undefined` (hybrid audit Row 9)

The last row of the hybrid fast-path safety-predicate audit
(`plan/log/hybrid-fastpath-audit.md` Row 9). A typed-array
(`Uint8Array`/`Int32Array`/`Float64Array`/…) out-of-bounds element read must
return JS `undefined` — the *view length* is the bound, per the integer-indexed
exotic object semantics (TC39 §10.4.5 `[[Get]]` with an out-of-range
CanonicalNumericIndexString returns `undefined`). Today the typed-array read site
in `compileElementAccessBody` (`src/codegen/property-access.ts`) returns a
type-default sentinel (0 / sNaN) on OOB instead.

## Why this was carved out of #2760 (R1)

R1's plain-array floor F1 (#2760) deliberately **excluded** typed-array views:
its `oobUndefined` gate requires `classifyTypedArrayType(...) === "other"`. The
2760 test even has an explicit scope-boundary canary asserting
`new Int32Array(3)[9] === undefined` is **false** ("out of F1 scope"). The
exclusion exists because the typed-array read is entangled with the **shared**
`emitBoundsCheckedArrayGet` helper (`array-methods.ts:386`) that also feeds the
`$__subview` and array-method callers — flipping that shared default was the S2
blast-radius leak (#2198). Row 9 closes the gap **without** touching the shared
helper, exactly as R1 did for plain arrays.

## Implementation (WHY, not just WHAT)

A **dedicated call-site helper** `emitTypedArrayUndefinedOobGet`, sibling to
R1's `emitPlainArrayUndefinedOobGet`. It is reached only from the two
`compileElementAccessBody` value-read call sites, gated on a genuine typed-array
receiver (`classifyTypedArrayType(...) !== "other"`). Three reasons it is a
*separate* helper rather than a reuse of `emitPlainArrayUndefinedOobGet`:

1. **Signedness.** A packed `i8`/`i16` typed-array element reads with
   view-name-driven sign/zero extension (`array.get_s` for `Int8/Int16`,
   `array.get_u` for `Uint8/Uint8Clamped/Uint16`). `emitPlainArrayUndefinedOobGet`
   calls the shared helper *without* `signedness`, whose storage-kind heuristic
   (i8→get_u, i16→get_s) would **miscompile** `Int8Array` (wants get_s) and
   `Uint16Array` (wants get_u). The typed-array helper threads `taSignedness`.
2. **Unsigned i32.** `Uint32Array` reads the full 32 bits as an *unsigned* JS
   number (0..2³²−1) — `f64.convert_i32_u`, not the signed conversion the plain
   box path uses.
3. **Audit guidance.** Row 9 says the typed-array policy "must stay scoped
   separately from F1's plain-array scope." A dedicated helper keeps both
   `emitPlainArrayUndefinedOobGet` *and* the shared `emitBoundsCheckedArrayGet`
   byte-identical.

The helper mirrors R1's proven floor-safe primitive sequence (the same
double-bounds-check + box + `emitUndefined` select), then boxes the element as a
**number** (`coerceType(f64 → externref)` → `__box_number`):

- `i8`/`i16` storage → read sign/zero-extends into i32 → `f64.convert_i32_s`
  (the value is already in range, signed conversion is correct for both views).
- `i32` storage → `f64.convert_i32_u` for `Uint32Array` (`signedness === "u"`),
  else `f64.convert_i32_s` (`Int32Array`).
- `f32` storage → `f64.promote_f32` (defensive; typed-array float views are
  f64-backed, so this does not occur in practice).
- `f64` storage → already a number (host-mode integer views are f64-backed;
  `Float64Array` always).

Boxing is **plain number boxing**, so — unlike #2792's `symbol[]` — it needs **no
new carrier** and is standalone-native (`__box_number`, identical to R1's
`number[]` floor, which is floor-green). So this ships for **both host and
standalone**. Standalone conflates `undefined ≡ null` (`emitUndefined` →
`ref.null.extern`), so `ta[OOB] === undefined` is satisfied by the native
sentinel — same as R1.

### Floor safety (#2097)

The policy is purely **call-site**: the helper's late-imports
(`__box_number`/`__get_undefined`) register only when a typed-array OOB read is
actually compiled, via the normal `flushLateImportShifts` path. A program with
no typed-array element reads emits byte-identical Wasm — nothing is added to
`addUnionImportsAsNativeFuncs` (the #2792 symbol[] breach of the absolute
standalone floor). The numeric-hint suppression (only widen when the consumer is
NOT expecting an `f64`/`i32`) keeps every hot numeric typed-array loop unboxed
and byte-identical — the R1 Math.pow lesson.

### Gating (both call sites, mutually exclusive with the plain-array arm)

1. `isSafeBoundsEliminated` — proven in-bounds, unboxed fast path (kept first).
2. plain-array F1 (`oobUndefined && f1BoxType !== null`, requires
   `taClass === "other"`).
3. **NEW** typed-array (`oobUndefinedTypedArray`, requires `taClass !== "other"`
   and `!numericHint`).
4. else — shared `emitBoundsCheckedArrayGet` (byte-identical).

## Acceptance criteria

- `Uint8Array`/`Int32Array`/`Float64Array` OOB element read (literal, negative,
  dynamic index) returns JS `undefined` in host mode.
- In-bounds typed-array reads return the correct numeric value (incl.
  `Uint32Array` unsigned, `Int8Array` signed).
- Shared-helper callers (subview, array methods, plain arrays) byte-identical —
  `emitBoundsCheckedArrayGet` and `emitPlainArrayUndefinedOobGet` untouched.
- Standalone OOB === undefined (undefined ≡ null), in-bounds preserved, valid
  Wasm with empty imports.
- Numeric-context typed-array reads (Math.* args) stay unboxed/correct.
- The #2760 scope-boundary canary is updated (Int32Array OOB now `undefined`).

## Test Results

(filled in below after implementation)
</content>
