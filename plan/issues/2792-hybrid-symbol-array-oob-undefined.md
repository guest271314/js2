---
id: 2792
title: "Hybrid: host symbol[] OOB → undefined (completes #2785 F1 host half; standalone deferred)"
status: done
completed: 2026-06-28
assignee: ttraenkler/sendev-symbox
sprint: 69
created: 2026-06-28
updated: 2026-07-03
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

# #2792 — host `symbol[]` OOB → `undefined` (completes #2785 F1, host half)

#2785 made `coerceType(i32 → externref)` brand-aware and re-enabled `boolean[]`
OOB→`undefined` in the hybrid type-soundness floor F1, deferring `symbol[]`
"pending a native standalone `__box_symbol`". This issue ships the **host** half:
a genuine `symbol[]` now reads JS `undefined` out of bounds and a value-correct
boxed `Symbol` in bounds, via the identity-stable host `__box_symbol` cache.
**Standalone `symbol[]` stays deferred** (unchanged from #2785) — see the parking
note below.

## What shipped (host)

- `f1ElementBoxType` (property-access.ts) returns `{ kind:"i32", symbol:true }`
  when the receiver element TS type is `symbol` **and `!noJsHost(ctx)`** (host
  only). The brand is reconstructed from the receiver TS type because vec dedup
  erases it in `arrDef.element` (same discipline as the `boolean[]` arm).
- `addUnionImports` (index.ts, **host path only**) registers `__box_symbol` as an
  `(i32)→externref` host import, added to the late-import index-shift
  `newImportNames` set. In standalone, `addUnionImports` returns before this
  block, so no symbol host import ever leaks into a standalone module.
- `coerceType(i32 → externref)`'s symbol arm (already wired by #2785) selects
  `__box_symbol` when the value is symbol-branded.

Result (host): `symbol[]` OOB → `undefined`; in-bounds → a real `Symbol`
(`.description` round-trips; per-element identity holds, distinct symbols are not
`===`). js-host conformance lane: **0 regressions**.

## STANDALONE DEFERRED — root cause (the senior-dev finding)

The first cut added a native standalone `__box_symbol`: a new
`__box_symbol_struct { value:i32 }` carrier + `__box_symbol` func in
`addUnionImportsAsNativeFuncs`, plus a tag-7 classify/compare in
`__any_from_extern` / `__any_strict_eq` / `__any_eq`. It passed local scoped
checks and the per-PR regression gate, but the **`merge_group` standalone
high-water floor (#2097) breached at -235**, and the deterministic diff showed
**311 wasm-hash-change regressions** — concentrated in `class/elements`,
`async-generator`, `DisposableStack` — all failing at runtime with
**`illegal cast [in __obj_find() ← __extern_set]`**.

Root cause (proven by a clean binary-hash bisection on the merged base —
`hashA` = current main, `hashB` = main + feature — **all** regressed-test
standalone binaries differed): registering the `__box_symbol_struct` type +
`__box_symbol` func **unconditionally** in `addUnionImportsAsNativeFuncs` — which
nearly every standalone program calls — shifts standalone **type/func indices**,
desyncing baked `ref.cast` targets in the object runtime
(`__obj_find`/`__extern_set`). This is the `project_type_index_shift_and_deadelim`
/ `reference_subview_type_idx_stability` hazard ("DCE remaps types; register
shared types late+once / reserve struct idxs up-front").

The safe fix gates `f1ElementBoxType`'s symbol arm to host (`!noJsHost`) and
**removes** the standalone carrier + tag-7 arms. Verified: the regressed-test
standalone binaries are now **byte-identical to clean main** (no index shift) and
all canaries are green in both modes. Standalone `symbol[]` falls through to the
shared bounded read (i32 handle) — exactly as #2785 left it.

### Follow-up (standalone `symbol[]`)

A native standalone `__box_symbol` must add its `__box_symbol_struct` carrier
WITHOUT shifting the indices baked by the object runtime — e.g. reserve the
carrier type/func up-front at a stable position (alongside `$AnyValue` reservation
in `ensureAnyValueType`), or gate registration on a `ctx.usesNativeBoxSymbol`
flag set during a pre-pass, then append last. Until then standalone `symbol[]`
OOB reads the i32 default (not `undefined`), and `===` on the i32 handles is
value-correct. Tracked toward #2610 (standalone symbol value-rep).

## Why NOT broad symbol branding in `type-mapper.ts`

Branding every symbol local/param `{ kind:"i32", symbol:true }` (so all
symbol→externref coercions route to `__box_symbol`) **regressed the host
`Object/values/symbols-omitted` canary**: branding only changes `coerceType`'s
box choice, but other boxing sites (object-literal fields) still box via
`__box_number`, so `Object.values({key:s})[0] === s` compared a `__box_symbol`
Symbol against a `__box_number` Number → `false`. This is exactly the blast
radius #2785 deferred. F1 keys on the receiver TS type instead
(`f1ElementBoxType` reconstructs the brand), so its box choice is self-consistent
without the global brand. Broad branding stays deferred to the symbol-as-`any`
value-rep pass (#2610). `type-mapper.ts` keeps `symbol → { kind:"i32" }` (a
comment records the decision).

## Files changed

- `src/codegen/property-access.ts` — `f1ElementBoxType` host-gated `symbol[]` arm
  + doc-comments.
- `src/codegen/index.ts` — host `__box_symbol` union import + `newImportNames`
  (standalone path untouched — no native carrier).
- `src/codegen/type-coercion.ts` — symbol-arm comment (host-only, F1-reconstructed
  brand, no broad branding).
- `src/checker/type-mapper.ts` — comment only (symbol stays `{ kind:"i32" }`).
- `tests/issue-2792.test.ts` (new).

## Acceptance criteria

- (host) `symbol[]` OOB read → JS `undefined`; in-bounds → a value-correct boxed
  `Symbol`. ✓
- (standalone) `symbol[]` deferred, byte-identical to clean main — NO regression
  (the merge_group standalone floor must not breach because of this PR). ✓
- Canaries green host + standalone: `Object/values/symbols-omitted`, boolean map,
  `number[]` OOB. ✓
- No net test262 regression in the `merge_group` re-validation.

## Test Results

- `tests/issue-2792.test.ts` (14) + `issue-2785` (20) + `issue-2760` (19) =
  **53 green**.
- `tsc --noEmit` clean; `check:stack-balance` OK; `check:ir-fallbacks` OK.
- Deterministic binary-hash bisection on the merged base: the 12 sampled
  regressed-test standalone binaries are **byte-identical** to clean current main
  (`hashA == hashOptB`) — the standalone index shift is eliminated.
- Empirical probes (host): `symbol[]` OOB (literal/dynamic/negative) → `undefined`;
  in-bounds → boxed `Symbol` with correct `.description`; per-element identity.
  Standalone: `symbol[]` deferred (i32 handle), canaries green.
