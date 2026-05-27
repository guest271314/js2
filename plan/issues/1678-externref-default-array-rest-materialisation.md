---
id: 1678
title: "externref-typed array/rest binding default not recognised by Array.isArray"
status: done
created: 2026-05-27
updated: 2026-05-27
completed: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: class-destructuring-methods
goal: property-model
sprint: 56
parent: 779a
es_edition: ES2017
test262_fail: 727
---
# #1678 — externref-typed array/rest binding default fails Array.isArray

## Problem

Carved from #779a. The dominant share of the ~727 `class/dstr-dflt` test262
failures is `assert(Array.isArray(x))` returning false for a rest/array
binding whose **default value** is statically typed `any` (externref).

```ts
// FAILS: default value typed `any` (externref)
let values: any; values = [1, 2, 3];
class C { static method([...x] = values) { /* Array.isArray(x) === false */ } }

// PASSES: default value typed number[] (vec struct)
var values = [1, 2, 3];
class C { static method([...x] = values) { /* Array.isArray(x) === true */ } }
```

The test262 harness declares `let values;` (type `any`) then assigns
`values = [...]`, so every `*-dflt-*` test takes the failing branch.

## Root cause (isolated 2026-05-27)

`Array.isArray(x)` was lowered as a **compile-time constant** in
`src/codegen/expressions/calls.ts` (the `Array.isArray` interceptor):

```ts
const isArr = argWasmType.kind === "ref" || argWasmType.kind === "ref_null";
fctx.body.push({ op: "i32.const", value: isArr ? 1 : 0 });
```

When the argument's static type is `any`/`unknown`, `argWasmType.kind` is
`externref`, so the fold produced `i32.const 0` — always false — regardless
of the runtime value. The rest binding `x` is correctly materialised to a
`__vec_externref` at runtime (its `.length` and element access work), but the
static fold never inspected it.

## Fix

`src/codegen/expressions/calls.ts` — when the `Array.isArray` argument is
`externref`-typed, emit a **runtime check** instead of a constant: compile the
arg to externref, `any.convert_extern`, then `ref.test` against every
registered vec struct type, OR-ing the results. Pure Wasm — no host import,
works in standalone/WASI mode, and matches how the compiler represents JS
arrays (vec structs). Statically-typed args keep the existing compile-time
fold (a `ref`/`ref_null` vec is an array; everything else is not).

## Acceptance criteria

- [x] `Array.isArray(x)` is true for a rest/array binding whose default value
      is `any`-typed and resolves to an array at runtime.
- [x] No regression: `Array.isArray` still false for `any`-typed
      object/string/number/null and true for statically-typed arrays.
- [x] Pure Wasm (no new host import) so standalone/WASI keep working.

## Notes / known limitation

- A vec struct backs both real arrays and `arguments` objects, so
  `Array.isArray(arguments)` is (still) true under this representation — a
  pre-existing limitation of the vec-as-array model, not introduced here.
- `nativeStrings` mode uses a distinct string type (not an array vec), so
  `Array.isArray("...")` stays false.

## Test Results

`tests/issue-1678.test.ts` (added) — 8 cases pass. Existing
`tests/issue-779a.test.ts` (5 cases) still pass.

## Merge note (2026-05-27, PR #705 ← main)

Main landed #1328's `Array.isArray` externref path (host predicate
`__extern_is_array`) while this branch was open. The two are complementary,
not exclusive: #1328 detects genuine host JS arrays (e.g. RegExp match
results) that are *not* WasmGC vec structs, whereas this fix detects compiled
native arrays materialised into the externref slot. The conflict was resolved
by **OR-ing both checks** in the `externref` branch — `ref.test` against every
vec struct type *and* the `__extern_is_array` host predicate when present.
Standalone/WASI builds (no host import) keep only the `ref.test` path; JS-host
builds get both. The externref value is stashed in a temp local so both checks
can consume it.
