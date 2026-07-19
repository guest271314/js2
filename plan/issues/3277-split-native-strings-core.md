---
id: 3277
title: "Decompose ensureNativeStringHelpers — extract the rope/flatten/UTF-8 core + concat/compare/slice builders (slice 2, empties the god-function)"
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

# Decompose `ensureNativeStringHelpers` — slice 2 (head/middle core builders)

## Scope

Slice 2 of the `ensureNativeStringHelpers` decomposition (stacked on #3275). Slice 1
lifted the `String.prototype` method-helper *tail*; slice 2 lifts the remaining
*head/middle* core builders (originally lines 301–2284), which **empties the
god-function** down to a ~48-line driver: the finalize-guard preamble + four type-index
consts + the shared-bag construction + 13 builder calls + the `emitNativeHtmlWrapperHelpers`
tail call.

Two NEW cohesive sibling modules:

- `src/codegen/native-strings-core.ts` — rope flatten & UTF-8 conversion core:
  `__str_copy_tree`, `__str_utf8_to_flat`, `__str_flatten` (`emitStrFlattenHelpers`) and
  `__str_to_utf8` (`emitStrToUtf8Helper`). The module-private pure helper
  `flattenConsBody` (#1588) moved here with the flatten block (it was used only by it).
- `src/codegen/native-strings-basics.ts` — concat/compare/slice/char access:
  `__str_concat`/`__str_buf_next_cap` (`emitStrConcatHelpers`), `__str_equals`/`__str_compare`
  (`emitStrCompareHelpers`), and `__str_substring`/`__str_charAt`/`__str_charAt_cp`/
  `__str_slice`/`__str_substr` (`emitStrSliceCharHelpers`).

The inline `strRef`/`flatStrRef`/`strDataRef`/`getFlattenIdx`/`wrapBodyWithFlatten` locals
are removed from the god-function — `makeNativeStrShared` (added in slice 1) now
reconstructs them for every builder.

## Why byte-identity holds

Same argument as slice 1: the builders run in the original registration order, so
`mintDefinedFunc`/`addFuncType`/`ctx.nativeStrHelpers.set`/`ctx.funcMap.set` (flatten's
extra registration) all fire at the same sequence points, and every baked-in sibling
funcIdx is unchanged. `flattenConsBody` is a pure `(…typeIdx, copyTreeIdx) => Instr[]`
function — relocating it emits identical bytes.

## Acceptance — all green locally

- `npx tsc --noEmit` → 0 errors.
- `npx tsx scripts/prove-emit-identity.mjs check` → **IDENTICAL — all 39 (file,target)
  emits match baseline** (gc / standalone / wasi).
- prettier, `loc-budget` (net +324 LOC, every new module < 1500), `dead-exports`,
  `oracle-ratchet` (+0), `coercion-sites`, `stack-balance` — all OK, no allowances.
- Smoke test `tests/issue-3277.test.ts` — exercises the core/basics builders (cons-string
  concat + flatten, equality/ordering, substring/charAt/slice/substr) under `--target
  standalone`. Passes.

## Result

- `src/codegen/native-strings.ts`: 4,062 → 2,025 LOC (−2,037; cumulative from #3263's
  6,811: `ensureNativeStringHelpers` went from ~4.8k inline LOC to a ~48-line driver).
- New: `native-strings-core.ts` (~1,150), `native-strings-basics.ts` (~955).
- `flattenConsBody` relocated into `native-strings-core.ts`.

The `ensureNativeStringHelpers` god-function is now fully decomposed into cohesive
sibling modules (`-shared`, `-core`, `-basics`, `-search`, `-transform`, `-rewrite`).
