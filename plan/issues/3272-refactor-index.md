---
id: 3272
title: "refactor(codegen): break up src/codegen/index.ts god-file + DRY cleanup (behaviour-preserving)"
status: done
completed: 2026-07-14
sprint: 72
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/sendev-godfile
loc-budget-allow: ["src/codegen/index.ts", "src/codegen/wasi.ts", "src/codegen/linear-type-reservations.ts", "src/codegen/closure-exports.ts", "src/codegen/struct-field-exports.ts", "src/codegen/vec-access-exports.ts", "src/codegen/extern-declarations.ts", "src/codegen/ast-modifiers.ts", "src/codegen/emit-helpers.ts"]
# (#3272) Verbatim god-file split: relocating checker call-sites into new sibling
# modules keeps TOTAL src/codegen/ oracle usage CONSERVED — index.ts's count drops
# by exactly what wasi.ts/extern-declarations.ts gain (byte-identity IDENTICAL, 39/39).
# array-prototype-borrow.ts is a pre-existing un-banked relocation from #3264 (the
# whole-tree gate false-positives on it until the post-merge baseline refresh banks it);
# waived here so this PR isn't blocked by another change-set's pending baseline bank.
# oracle-ratchet-allow lists (1) this change-set's own new modules (verbatim-relocated
# checker sites: wasi.ts, extern-declarations.ts); and (2) inherited main baseline-lag
# from concurrent god-file splits merged into this branch — the oracle baseline is not
# auto-refreshed for increases, so a downstream PR that merges main after those land
# re-flags files it never touched. Same remedy #3267/#3268 applied; a no-op once the
# post-merge bank catches up.
oracle-ratchet-allow:
  - src/codegen/wasi.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/array-prototype-borrow.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/declarations/struct-type-registration.ts
  - src/codegen/expressions/calls.ts
# (#3272) Verbatim relocation of existing box/unbox/to-string coercion vocabulary out
# of index.ts into the extracted modules — total coercion-site count conserved, no new
# hand-rolled matrix (byte-identity IDENTICAL, 39/39).
coercion-sites-allow:
  - src/codegen/closure-exports.ts
  - src/codegen/struct-field-exports.ts
  - src/codegen/vec-access-exports.ts
  - src/codegen/wasi.ts
---

# refactor(codegen): break up src/codegen/index.ts god-file + DRY cleanup

## Problem

`src/codegen/index.ts` is a ~14k-LOC god file. It mixes the compile driver with
several self-contained emission subsystems (WASI IO helpers, closure-call host
exports, struct-field getter/setter exports, vec-access exports, extern/declare
collection). This makes it hard to navigate, review, and reason about, and it
carries repeated inline idioms (synthetic-struct-name skip guard, func-export
push, found-flag AST walks) that should be single shared helpers.

## Scope (behaviour-preserving — byte-identity ABSOLUTE)

Extract cohesive function groups into new sibling modules (verbatim moves +
rewire; origin re-exports what external modules import, imports back what it
still calls); apply high-confidence DRY dedups. Every change keeps emitted Wasm
byte-for-byte identical (`scripts/prove-emit-identity.mjs check` = IDENTICAL,
39/39) and `tsc --noEmit` at 0.

### Extractions
- `src/codegen/wasi.ts` — WASI IO helper subsystem
- `src/codegen/linear-type-reservations.ts` — linear/typed-array type reservations
- `src/codegen/closure-exports.ts` — `__call_fn_<N>` host-dispatch + closure classification exports
- `src/codegen/struct-field-exports.ts` — `__get_field_*`/`__set_field_*`/`__struct_field_names`
- `src/codegen/vec-access-exports.ts` — `__vec_*`/`__dv_byte_*`/`__new_vec_f64` exports
- `src/codegen/extern-declarations.ts` — ambient/extern/declare collection pre-pass
- `src/codegen/ast-modifiers.ts` — tiny `ts.getModifiers` predicate utils

### Dedups
- `isSyntheticStructName(structName)` — 4-clause synthetic-struct skip guard
- `exportFunc(mod, name, funcIdx)` — func-export push idiom
- reference existing `TYPED_ARRAY_NAMES` const instead of a local dup Set
- `sourceHasNode(sf, match)` — found-flag early-exit AST walk

## Acceptance criteria
- `npx tsx scripts/prove-emit-identity.mjs check` prints IDENTICAL (39/39 file,target across gc/standalone/wasi)
- `tsc --noEmit` = 0 errors
- Relocation-shift ratchets green (per-issue frontmatter allowances only)
- `tests/issue-3272.test.ts` smoke test passes

## Result

`src/codegen/index.ts`: **13,964 → 7,056 LOC** (−6,908, ~49%). All 7 extractions +
3 DRY dedups landed with byte-identity **IDENTICAL** (39/39 gc/standalone/wasi) after
every step; `tsc --noEmit` = 0. New sibling modules: `ast-modifiers.ts` (37),
`linear-type-reservations.ts` (254), `vec-access-exports.ts` (1075), `closure-exports.ts`
(1064), `struct-field-exports.ts` (968), `wasi.ts` (2131), `extern-declarations.ts` (1536),
`emit-helpers.ts` (32). Net tree LOC +189 (per-module copyright headers + import blocks).

## Implementation notes (WHY, not just WHAT)

- **Extraction mechanic**: each block was moved VERBATIM (JSDoc included) via exact
  line-range cut. The new module `export`s the moved fns + imports their deps on rebased
  paths; `index.ts` imports back only what its compile driver still calls internally and
  re-exports only the symbols that were `export function` before (external importers stay
  on `./index.js` — the established re-export pattern). `tsc` is the dependency oracle;
  `prove-emit-identity` is the behaviour oracle — run after every single move.
- **`LINEAR_U8_ARENA_START` lives with `linear-type-reservations.ts`, not `wasi.ts`**
  (the analysis had it in wasi). `ensureLinearU8AllocHelper` is its primary owner; placing
  it there makes the edge `wasi.ts → linear-type-reservations.ts` (one-way), so
  `object-runtime.ts` (which pulls the `reserve*` fns via the index re-export) never
  transitively imports the WASI IO module. Keeping the dependency direction right was the
  whole point of splitting linear-reservations out of the WASI cluster.
- **`reportError` DOM-global shadow (subtle, caught by tsc)**: `extern-declarations.ts`
  called `reportError(ctx, node, msg)` but had no local import; TypeScript silently
  resolved it to the DOM lib's global `reportError(e)` (1 arg) → `TS2554`, NOT `TS2304`.
  A missing import that a global masks is exactly the class of relocation bug byte-identity
  alone would not surface at compile time — the tsc arg-count error did. Fixed by importing
  the local `reportError` from `./context/errors.js`.
- **Ratchets** (relocation-shift): `oracle-ratchet` and `coercion-sites` flagged the
  RELOCATED checker/coercion vocabulary in the new modules — total usage is conserved
  (index.ts drops by the same amount), so waived via per-issue `oracle-ratchet-allow:` /
  `coercion-sites-allow:` frontmatter (never the whole-tree baseline, #3131).
  `array-prototype-borrow.ts` also appears in `oracle-ratchet` — a PRE-EXISTING un-banked
  relocation from #3264 that the whole-tree gate false-positives on until the post-merge
  baseline refresh banks it; waived so this PR isn't blocked by another change-set's
  pending bank. `dead-exports` moved 2 blind-spot entries (`getPseudoExternClassInfo` /
  `resolveMethodDispatchTarget`, reachable only via the index re-export) from the
  `index.ts#` path to the `extern-declarations.ts#` path in the committed baseline —
  a surgical 2-line edit (no reformat churn).

## Test Results
- `tests/issue-3272.test.ts`: 7/7 pass — exercises struct-field getters/setters,
  closure `__call_fn` dispatch, vec access, enum/extern-declaration, plus standalone and
  wasi target module emission.
