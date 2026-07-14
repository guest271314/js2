---
id: 3272
title: "refactor(codegen): break up src/codegen/index.ts god-file + DRY cleanup (behaviour-preserving)"
status: in-progress
sprint: current
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/sendev-godfile
loc-budget-allow: ["src/codegen/index.ts", "src/codegen/wasi.ts", "src/codegen/linear-type-reservations.ts", "src/codegen/closure-exports.ts", "src/codegen/struct-field-exports.ts", "src/codegen/vec-access-exports.ts", "src/codegen/extern-declarations.ts", "src/codegen/ast-modifiers.ts"]
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
</content>
