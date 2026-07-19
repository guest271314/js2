---
id: 3270
title: "refactor(codegen): break down + DRY closures.ts god-file (behaviour-preserving)"
status: done
completed: 2026-07-14
sprint: 72
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/sendev-closures
# Relocation-shift ratchet allowances (#3131 change-scoped hatch). This PR is a
# VERBATIM god-file split (byte-identity IDENTICAL across all 39 gc/standalone/
# wasi emits): every flagged checker-usage "growth" in the NEW destination module
# is a call-site RELOCATED out of closures.ts, so total repo usage is conserved.
# array-prototype-borrow.ts + expressions/calls.ts are PRE-EXISTING whole-tree
# drift already present on origin/main (baseline not yet reseeded after #3264/
# #3172); the whole-tree-absolute gate inherits them onto every PR, so they are
# waived here too — same as sibling split #3267 did for array-prototype-borrow.ts.
oracle-ratchet-allow:
  - src/codegen/closures/callback-classification.ts
  - src/codegen/array-prototype-borrow.ts
  - src/codegen/expressions/calls.ts
---

# refactor(codegen): break down + DRY `src/codegen/closures.ts`

## Problem

`src/codegen/closures.ts` is a ~5145 LOC god-file mixing several cohesive
subsystems (lexical/free-variable scope analysis, host-vs-GC callback
classification, funcref-wrapper type registry, method-ABI trampolines,
funcref-as-closure wrapping, lifted-param defaults + destructuring) plus a
substantial amount of copy-pasted instruction-emission idioms.

## Scope

Behaviour-preserving GOD-FILE breakdown + DRY cleanup. Two levers:

1. **EXTRACTION** — pull cohesive function groups into new sibling modules
   under `src/codegen/closures/`:
   - `scope-analysis.ts` — AST free-variable / lexical-scope predicates + collectors
   - `callback-classification.ts` — host-vs-GC callback decision + allowlists
   - `funcref-wrapper-types.ts` — funcref-wrapper struct/func-type registry
   - `method-trampolines.ts` — method-ABI→closure-ABI trampoline machinery
   - `funcref-as-closure.ts` — memoized nested-fn-declaration closure wrapping
   - `param-init.ts` — lifted-param defaults + binding-pattern destructuring
   `closures.ts` keeps a re-export barrel so external importers are unaffected.

2. **DRY DEDUP** — factor genuinely-repeated emission idioms into shared
   helpers (binding-default sentinel dispatch, `__extern_is_undefined`
   ensure+flush, null-guarded splice tail, capture-field builder,
   default-return-value tail, lazy closure-cache access, own-locals set,
   collect-over-body).

## Acceptance

- `npx tsx scripts/prove-emit-identity.mjs check` prints **IDENTICAL** (39/39
  file,target across gc/standalone/wasi) — emitted Wasm byte-for-byte unchanged.
- `npx tsc --noEmit` stays at 0 errors.
- Relocation-shift ratchets green (loc-budget / oracle-ratchet / coercion-sites
  / dead-exports / verdict-oracle-bump), with per-issue frontmatter allowances
  as needed (never whole-tree baseline edits, #3131).
- Smoke test `tests/issue-3270.test.ts` compiles programs exercising the touched
  closure/callback/param-default paths.

## Implementation Notes

`src/codegen/closures.ts` went from **5145 → 3472 LOC** (−1673). Byte-identity
proven IDENTICAL (39/39 gc/standalone/wasi) at every step, and finally against
current `origin/main` by swapping the monolithic `closures.ts` back in over the
split and confirming the same emit. `tsc --noEmit` stayed at 0 throughout.

### Extractions (verbatim moves, new modules under `src/codegen/closures/`)

1. **`funcref-wrapper-types.ts`** (~100 LOC) — `getFuncSignature`,
   `getOrCreateFuncRefWrapperTypes`, `getFuncRefWrapperRootTypeIdx`. Extracted
   FIRST because it is the shared dependency of the two closure-emit modules
   below; pulling it out lets them import it directly instead of back-importing
   `closures.ts`. Isolates the #2873 isorecursive root-wrapper canonicalization.
2. **`callback-classification.ts`** (~330 LOC) — the host-`__make_callback` vs
   GC-closure-struct decision (`isHostCallbackArgument`,
   `isDeferredCallbackArgument`, `isJsonReviverArgument`, `isVecOrArrayRefType`)
   + its four allowlist constants. Pure, read-only over `CodegenContext`.
3. **`funcref-as-closure.ts`** (~410 LOC) — `emitFuncRefAsClosure` + its private
   `emitMemoizedNestedFnClosure`. Depends only on `funcref-wrapper-types` + emit
   primitives → **no back-import into `closures.ts`**.
4. **`method-trampolines.ts`** (~790 LOC, the largest single subsystem) — the
   method-ABI→closure-ABI trampoline machinery + the pending-trampoline finalize
   pass + the null-`this` TypeError / `this`-slot helpers. Self-contained (no
   back-reference into `closures.ts`); cut with an asserted script so the bytes
   are provably verbatim.

`closures.ts` keeps a re-export barrel for every symbol external modules import,
so no importer changed. `scope-analysis.ts` and `param-init.ts` were left in
place: their functions are heavily interleaved with closure-compiler helpers
that stay, so a many-cut extraction carried more byte-identity risk than value.
`compileArrowAsClosure` (~1370 LOC) is the remaining mega-function → wave B.

### DRY dedups (7 shared helpers, every call site byte-identical)

`param-emit-helpers.ts` (leaf, type-only imports) holds the two cross-cutting
helpers; the rest are local where all their sites live.

- `spliceNullGuarded` (5 sites) — null-guarded destructuring splice tail
- `emitDefaultReturnValue` (2) — lifted-body default-return-value tail
- `buildCaptureFieldDef` (2) — per-capture struct-field builder
- `collectOverBody` (5) — block-vs-expression collect-over-body fan-out
- `arrowOwnLocals` (3) — own-locals shadow-set builder
- `emitLazyClosureCacheAccess` (2, in `method-trampolines.ts`) — lazy externref
  closure-cache access kernel
- `ensureExternIsUndefinedImport` + `emitExternIsUndefinedCheck` (5) — the
  `__extern_is_undefined` ensure+flush+call-or-fallback idiom

**dedupsBackedOut: 0** — no dedup broke byte-identity. `emitBindingDefaultInit`
and `emitCaptureExtraction` were deliberately NOT attempted (temp-local-name /
field-offset sensitivity → higher drift risk for marginal gain).

### Relocation-shift ratchets

`oracle-ratchet` flags `callback-classification.ts` (my verbatim relocation of
`ctx.checker` sites out of `closures.ts` — total usage conserved) plus
`array-prototype-borrow.ts` and `expressions/calls.ts`, which are **pre-existing
whole-tree drift already on `origin/main`** (baseline not reseeded after #3264 /
#3172). Per the #3131 change-scoped hatch — exactly as sibling split #3267 did —
all three are waived via the `oracle-ratchet-allow` frontmatter above. loc-budget,
coercion-sites, verdict-oracle-bump all green with no allowance needed.
