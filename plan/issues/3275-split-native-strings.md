---
id: 3275
title: "Decompose ensureNativeStringHelpers — extract String.prototype method helpers (search/trim/transform/rewrite) into sibling modules (slice 1)"
status: done
completed: 2026-07-14
sprint: 72
priority: high
feasibility: hard
model: opus
task_type: refactor
subtask_of: 3182
assignee: ttraenkler/sendev-natstr
area: codegen
---

# Decompose `ensureNativeStringHelpers` — slice 1 (method-helper tail)

## Scope

Behaviour-preserving **intra-function** decomposition of the ~4.8k-LOC god-function
`ensureNativeStringHelpers` in `src/codegen/native-strings.ts` (the file's remaining
core after the wave-1 TextEncoder/TextDecoder split, #3263). The function builds
every native-string helper routine sequentially inline. Slice 1 lifts the cohesive
**`String.prototype` method-helper tail** (originally lines 2279–5051) verbatim into
three NEW cohesive sibling modules, plus a shared-state factory:

- `src/codegen/native-strings-shared.ts` — `NativeStrShared` bag + `makeNativeStrShared`
  factory. Reconstructs the per-call derived state the original computed once at the top
  (`strRef`/`flatStrRef`/`strDataRef` ValTypes, `getFlattenIdx`, `wrapBodyWithFlatten`)
  from the four native-string type indices. Mirrors the `html-wrapper-native.ts` (#3069)
  reconstruction precedent; `wrapBodyWithFlatten` is a pure function relocated verbatim.
- `src/codegen/native-strings-search.ts` — search & trim: `indexOf`, `lastIndexOf`,
  `includes`, `startsWith`, `endsWith`, `isWhitespace`, `trimStart`, `trimEnd`, `trim`.
- `src/codegen/native-strings-transform.ts` — length & case: `repeat`, `padStart`,
  `padEnd`, `toLowerCase`/`toUpperCase` (+ Unicode `emitNativeCaseConversion` +
  `isWellFormed`/`toWellFormed`).
- `src/codegen/native-strings-rewrite.ts` — replacement/split/construction/escape:
  `getSubstitution`, `replace`, `replaceAll`, `split`, `fromCodePoint`, `fromCharCode`,
  `__regex_escape`.

The inline blocks are replaced by 8 builder calls invoked **in the original order**,
AFTER the core helpers (`__str_flatten`, `__str_concat`, `__str_equals`,
`__str_substring`, …) are registered — each builder looks those up by name in
`ctx.nativeStrHelpers`, so preserving the call order preserves every baked-in sibling
funcIdx and every `mintDefinedFunc`/`addFuncType` side-effect sequence.

## Why byte-identity holds (implementation notes — the WHY)

- **Registration order is a valid topological order.** Every helper block only
  `.get()`s helpers registered *earlier* (a forward reference would already crash the
  unmodified compiler). Relocating a contiguous tail run and calling it at the same
  position keeps `mintDefinedFunc` minting the same sequential funcIdx values and every
  `ctx.nativeStrHelpers.set` at the same point.
- **No cross-block shared closures beyond three.** The only function-scope symbols the
  tail references are `strRef`/`flatStrRef`/`strDataRef`, `getFlattenIdx`, and
  `wrapBodyWithFlatten` — all pure functions of the four type indices, reconstructed
  identically by `makeNativeStrShared`. `wrapBodyWithFlatten` is a pure Instr→Instr
  transform, so a second identical closure emits identical bytes.
- **The two `emitNative{CaseConversion,WellFormed}Helpers` calls** sat inside the tail
  range and moved with it (into `native-strings-transform.ts`); their now-unused imports
  were dropped from `native-strings.ts`.

## Acceptance — all green locally

- `npx tsc --noEmit` → 0 errors.
- `npx tsx scripts/prove-emit-identity.mjs check` → **IDENTICAL — all 39 (file,target)
  emits match baseline** (gc / standalone / wasi). This is the behaviour gate.
- prettier, `loc-budget` (net +291 LOC, every new module < 1500), `dead-exports`,
  `oracle-ratchet` (+0 checker usage), `coercion-sites`, `verdict-oracle-bump`,
  `any-box-sites`, `speculative-rollback`, `stack-balance` — all OK, no allowances needed
  (intra-function relocation is net-zero per #3070).
- Smoke test `tests/issue-3275.test.ts` — exercises all four extracted families at
  runtime under `--target standalone` (pure Wasm, no JS host). Passes.

## Result

- `src/codegen/native-strings.ts`: 6,811 → 4,062 LOC (−2,749).
- New: `native-strings-shared.ts` (~135), `native-strings-search.ts` (864),
  `native-strings-transform.ts` (581), `native-strings-rewrite.ts` (1,471).

Follow-up slices (stacked): the head/middle core builders (`__str_copy_tree`,
`__str_utf8_to_flat`, `__str_flatten`, `__str_to_utf8`, `__str_concat`,
`__str_buf_next_cap`, `__str_equals`, `__str_compare`, `__str_substring`, `__str_charAt`,
`__str_charAt_cp`, `__str_slice`, `__str_substr`) are extracted in the next slice off
this branch.
