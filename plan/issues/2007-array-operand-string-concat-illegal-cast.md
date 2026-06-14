---
id: 2007
title: "array operand in string concatenation traps 'illegal cast' — '+' never routes vecs through ToPrimitive/join"
status: done
completed: 2026-06-14
sprint: 63
created: 2026-06-10
updated: 2026-06-14
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1969, 1997, 1988]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2007 — struct-ref concat path can't handle WasmGC vec refs

## Problem

```ts
const arr = [1, 2];
"a=" + arr   // wasm: RuntimeError: illegal cast   node: "a=1,2"
```

## Root cause

`src/codegen/string-ops.ts:1503-1508` — struct-ref operands route through
`coerceType(..., externref, "string")`, but the ToPrimitive dispatch path
doesn't handle WasmGC array/$Vec refs (unguarded `ref.cast` in
`src/codegen/type-coercion.ts`), so arrays never reach
Array.prototype.toString/join.

## Fix direction

Detect vec refs in the concat coercion and emit the join path (ties into
#1997 array toString and #1996 host bridge vec recognition).

## Acceptance criteria

- Repro returns "a=1,2"; nested arrays follow join semantics

## Dupe check

#1090/#1806 cover "cannot convert object to primitive" for plain structs;
#1969 is concat-the-method, not `+`. New.

## Resolution (2026-06-14, dev-a)

**js-host mode was already fixed** (by #2022 `+` ToPrimitive ordering + #1997
Array.join element coercion). The remaining gap was **standalone / native-strings
mode**, where `"" + [1,2]` returned `"[object Object]"` (length 15): the
`$__any_to_string` walker tested `$AnyString` → `$AnyValue` (tag) → else
`"[object Object]"`, and a vec ref matched neither.

### Fix

`src/codegen/native-strings.ts`:
- `ensureNativeVecJoinHelper(elemKind, vecTypeIdx, arrTypeIdx, anyToStringFuncIdx)`
  — emits a per-vec-type `__vec_join_<elemKind>(ref null $__vec_<kind>) ->
  ref $AnyString` that joins elements with `","` using `__str_concat`. Numeric
  elements go via `number_toString` (ensured via `emitNativeNumberFormat` so a
  vec join inside a template literal — where `number_toString` is not yet
  registered — does not silently fall back); string elements pass through; ref
  elements (nested vec / object) recurse through `$__any_to_string`, so
  `[[1,2],[3]]` → `"1,2,3"`.
- `patchAnyToStringVecArm` — splices a `ref.test $__vec_<kind>` arm for every
  registered vec type ahead of the `"[object Object]"` fallback inside
  `$__any_to_string`, so a type-erased / nested vec recurses to the join helper.
- `tryCompileNativeVecConcatOperand` — call-site entry point: when a concat /
  template operand is a statically-known vec ref, calls the join helper directly
  (the concrete vec type is known there, sidestepping the type-erased dispatch).

`src/codegen/string-ops.ts`:
- `compileNativeConcatOperand` (the standalone `+` path) and
  `compileNativeTemplateExpression` (template span) — try
  `tryCompileNativeVecConcatOperand` before the `tryStructToString` /
  `$__any_to_string` fallthrough.

### Test results (standalone)

`tests/issue-2007.test.ts` — 9/9 pass. All previously `"[object Object]"`:
`"" + [1,2]` → `"1,2"`, `"a=" + [1,2]` → `"a=1,2"`, floats, `string[]`,
single, empty `→ ""`, nested `[[1,2],[3]]` → `"1,2,3"`, template
`` `v=${[1,2,3]}` `` → `"v=1,2,3"`, and the standalone module has zero host
imports. No regressions: `issue-2074` (12), `issue-2022` (7),
`issue-1539-standalone-array-coercion` (3), `native-strings-roundtrip` (7),
`issue-1470-string-coercion-standalone` (4) all pass.
