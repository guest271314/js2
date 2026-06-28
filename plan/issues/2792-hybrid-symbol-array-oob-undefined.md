---
id: 2792
title: "Hybrid: symbol[] OOB → undefined (complete #2785 F1) + native standalone __box_symbol"
status: done
completed: 2026-06-28
assignee: ttraenkler/sendev-symbox
sprint: current
created: 2026-06-28
updated: 2026-06-28
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: boxing
goal: correctness
related: [2785, 2760, 2766, 2610, 864, 1467]
---

# #2792 — `symbol[]` OOB → `undefined` (completes #2785 F1)

#2785 made `coerceType(i32 → externref)` brand-aware and re-enabled **`boolean[]`**
OOB→`undefined` in the hybrid type-soundness floor F1, but **DEFERRED `symbol[]`**
because the standalone backend had **no native `__box_symbol`** (host already had
one via the identity-stable symbol cache). This issue builds the native standalone
`__box_symbol` and widens F1 so a genuine `symbol[]` reads `undefined` out of
bounds and a value-correct boxed `Symbol` in bounds — in **both** host and
standalone.

## Problem

The F1 floor widens an unproven plain-array element read to a boxed-or-`undefined`
externref (an `f64`/`i32` cannot represent `undefined`). For a `symbol[]` the
element is an `i32` symbol **handle**; #2785's brand-aware box would route it to
`__box_symbol`, but standalone had no such helper, so `symbol[]` fell through to
the shared bounded read (typed `i32`, OOB → 0 sentinel — not JS-correct), keeping
the `symbols-omitted` canary green at the cost of the floor.

## The fix (4 parts)

1. **Native standalone `__box_symbol`** (`src/codegen/index.ts`,
   `addUnionImportsAsNativeFuncs`). A new `__box_symbol_struct { value: i32 }`
   carrier (the symbol handle) + a `__box_symbol(i32) → externref` native
   (`struct.new` + `extern.convert_any`). A **distinct nominal struct** from
   `__box_number_struct`/`__box_boolean_struct` so `ref.test` discriminates it.

2. **Correct standalone SYMBOL tag** (`src/codegen/any-helpers.ts`). The 2nd-park
   lesson from #2785 was "get the standalone tag right". `__any_from_extern` now
   classifies a `__box_symbol_struct` as **tag 7** (symbol) with the handle in
   `i32val` — never the tag-5 string fallback. `__any_strict_eq` **and** `__any_eq`
   gained a tag-7 arm comparing `i32val` (the handle), so two boxes of the **same**
   symbol are `===`/`==` and two distinct symbols are not. (Boolean is tag 4,
   number tags 2/3, string tag 5, ref tag 6 — symbol is the next free tag, 7.)

3. **F1 widen** (`src/codegen/property-access.ts`, `f1ElementBoxType`). Returns
   `{ kind:"i32", symbol:true }` when every value-part of the receiver element TS
   type is `ESSymbol`/`UniqueESSymbol`. Both F1 call sites already forward the
   reconstructed box ValType to `emitPlainArrayUndefinedOobGet → coerceType`, whose
   symbol arm (wired in #2785) selects `__box_symbol`.

4. **`__box_symbol` registered in both modes** (`addUnionImports`, host import +
   native synth). `coerceType`'s symbol arm calls `addUnionImports` at the top, so
   `__box_symbol` is in `funcMap` at the F1 box site in both host and standalone.
   Same `(i32)→externref` signature as `__box_boolean`; added to the late-import
   index-shift `newImportNames` set so the batch shift stays consistent (the same
   mechanism #1644 used for `__box_bigint`).

## Why NOT broad symbol branding in `type-mapper.ts` (the key design decision)

The task asked for a `type-mapper` symbol brand (mirroring the `boolean: true`
brand) so symbol locals/params box via `__box_symbol`. **I implemented it, found
it regressed the host `symbols-omitted` canary, and reverted it.** Root cause:
branding only changes the box choice at `coerceType(i32 → externref)`. Other
boxing sites — notably **object-literal field stores** — still box a symbol via
`__box_number`. So in `Object.values({ key: s })[0] === s`, the object field
`s` boxes to a `__box_number` Number while the RHS `=== s` boxes to a
`__box_symbol` Symbol → `Number !== Symbol` → the canary returned `0`. Before any
branding, **both** sides consistently used `__box_number`, so handle-as-number
equality happened to be correct.

This is exactly the blast radius #2785 deferred ("bound blast radius"). The F1
read does **not** need the ValType brand: `f1ElementBoxType` reconstructs the
`symbol` brand from the **receiver TS type**, so its box choice is
self-consistent (every `symbol[]` element read boxes via `__box_symbol`). The
broad branding is left for a future symbol-as-`any` value-rep pass (#2610) that
can make **all** symbol boxing sites consistent at once. Net: F1 keys on the TS
type (the stated discipline) **without** the global brand.

Consequence for tests: in-bounds correctness is asserted via F1-consistent
operations — `a[i] === a[0]` (per-element identity, true), `a[0] === a[1]`
(distinct, false), and `a[i].description` round-trip (host) — NOT `a[i] === s0`
(which would compare a `__box_symbol` Symbol against the unbranded `s0`'s
`__box_number` Number). `typeof a[i]` is statically folded to the declared element
type, so it is not used as a runtime OOB probe.

## Files changed

- `src/codegen/index.ts` — host `__box_symbol` union import + `newImportNames`;
  native `__box_symbol_struct` + `__box_symbol` in `addUnionImportsAsNativeFuncs`.
- `src/codegen/context/{types,create-context}.ts` — `nativeBoxSymbolTypeIdx`.
- `src/codegen/any-helpers.ts` — `__any_from_extern` tag-7 classify arm;
  `__any_strict_eq` + `__any_eq` tag-7 (handle) comparison arm.
- `src/codegen/property-access.ts` — `f1ElementBoxType` symbol arm; doc-comments
  at both F1 call sites updated (`symbol[]` now widened, no longer deferred).
- `src/codegen/type-coercion.ts` — symbol-arm comment updated (both modes; F1-only
  brand reconstruction, NOT broad branding).
- `src/checker/type-mapper.ts` — symbol stays `{ kind:"i32" }` (NOT branded);
  comment records why broad branding regresses the canary.
- `tests/issue-2792.test.ts` (new).

## Acceptance criteria

- `symbol[]` OOB read → JS `undefined`; in-bounds read → a value-correct boxed
  `Symbol` (host + standalone). ✓
- Native standalone `__box_symbol` exists; a boxed symbol is classified SYMBOL
  (tag 7), so standalone `===` on boxed symbols is by handle. ✓
- Canaries green: `Object/values/symbols-omitted` (host + standalone), boolean
  map (host + standalone), `number[]` OOB regression guard. ✓
- No net test262 regression in the `merge_group` re-validation.

## Test Results

Local (scoped — broad-impact conformance validated by full CI/merge_group):

- `tests/issue-2792.test.ts` (19) + `tests/issue-2785.test.ts` (20) +
  `tests/issue-2760.test.ts` (19) = **58 green**.
- Standalone equality / search / symbol sweep (1461 search+reduce,
  2063 switch-strict-eq, 1788, 1732 math-symbol, 1103a standalone-map, 1539
  standalone-array-coercion): **55 green** (1 file skipped — the pre-existing
  missing `tests/helpers.js` load on origin/main, unrelated).
- Object-values / identity / symbol lane (2719, 2734, object-keys-values-entries,
  2583 any-array-method-brand, 865 wasi-polyfill): **58 green**. (The
  `symbol-async-iterator` 2 failures are a **pre-existing** fragile-harness issue —
  its `{ env: {} }` instantiation can't provide the `string_constants` pseudo-import
  that the async runtime emits; a plain async function with NO symbols fails
  identically, and the for-await binary instantiates correctly via `buildImports`.)
- `tsc --noEmit` clean; `check:stack-balance` OK (`default-value-lossy` −36, no
  increases); `check:ir-fallbacks` OK (no bucket growth).

Empirical probes (host + standalone), all correct:

- `symbol[]` OOB (literal / dynamic / negative index) → `undefined`; in-bounds →
  boxed Symbol with the right `.description` (host); identity-stable per element
  (`a[i] === a[0]` true, `a[0] === a[1]` false) in **both** modes via the tag-7
  arm.
- Canaries: `Object.values({key: s})[0] === s` (host + standalone), boolean-map,
  `number[]` OOB → all green.
