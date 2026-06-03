---
id: 1748
title: "readonly array as a nested struct field traps on indexed read (compiled WasmGC)"
status: done
created: 2026-05-30
updated: 2026-06-03
completed: 2026-06-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, structs, arrays, type-coercion
language_feature: readonly-array, struct-field, indexed-read
goal: standalone-correctness
sprint: Backlog
related: [1584, 1747]
---
# #1748 — `readonly` array as a nested struct field traps on indexed read

## Problem

When an interface/object field is typed `readonly T[]` (e.g.
`readonly number[]`) and the object is itself an element of an array, reading
an element of that nested field after indexing the outer array **traps** at
runtime in the compiled WasmGC module. The identical code with a plain
(non-`readonly`) `T[]` field compiles and runs correctly. The `readonly`
modifier changes how the array field is lowered (apparently to an immutable
WasmGC array variant) and the nested-field read mismatches, producing a trap.

This is a standalone-mode correctness bug independent of #1584; it was
surfaced while building the #1584 bytecode VM (whose function table is an
array of structs with array-typed `code`/`constPool` fields).

## Repro

```ts
interface FE { code: readonly number[]; arity: number; }      // TRAPS
interface PG { functions: readonly FE[]; entry: number; }
export function run(): number {
  const program: PG = { functions: [{ code: [7, 2], arity: 1 }], entry: 0 };
  const entryFn = program.functions[program.entry];
  return entryFn.code[0]; // expected 7; the compiled module traps here
}
```

Changing both field types to non-`readonly` (`code: number[]`,
`functions: FE[]`) makes the identical logic return `7`. Bisected: the trap
appears only with `readonly` on the **nested array field that is read after an
index**; `readonly` on a top-level local array, or a scalar `readonly` field,
does not trap.

## Expected

`readonly T[]` should lower identically to `T[]` for read access — `readonly`
is a TypeScript-only compile-time modifier with no runtime representation
difference. The fix is likely in the array-type lowering / struct-field type
resolution: treat `readonly T[]` as `T[]` for the WasmGC array type (or emit
the same `array.get` regardless of the `readonly` flag).

## Workaround (in #1584)

The #1584 VM drops `readonly` from `FuncEntry`/`Frame`/`Program` array fields
(plain `number[]`), which lowers correctly. The VM never mutates them, so this
is safe — but the codegen should handle `readonly` array fields so other
compiled code isn't forced to drop the modifier.

## Notes

- Found via the slice-(b) "compile the dispatch loop itself" arm.
- See [[1747]] for a sibling codegen trap found in the same investigation
  (`[].pop()` on an empty array).

## Resolution (2026-06-03)

Root cause: a `readonly T[]` / `ReadonlyArray<T>` type has the TS checker
symbol name `"ReadonlyArray"`, not `"Array"`. `resolveWasmType`
(`src/codegen/index.ts`) only matched `sym?.name === "Array"` when lowering a
type to the vec ref `ref_null $vec_<elem>`. A `ReadonlyArray`-typed struct
field therefore fell through to the anonymous-struct / externref path while the
object literal's array value was still built as a vec — the two
representations mismatched and indexed reads trapped.

Fix (all `src/codegen/index.ts`):
1. `resolveWasmType` — match `sym?.name === "Array" || === "ReadonlyArray"`.
2. IR `resolvePositionType` — unwrap the `readonly` `TypeOperatorNode` to its
   inner type, and accept `ReadonlyArray<T>` in the `Array<T>` reference arm
   (keeps the IR path active rather than falling back to legacy).

`ensureStructForType` already guarded `ReadonlyArray` (so it never built an
anon struct for the field); the missing half was `resolveWasmType` picking the
vec type for the field slot. Tests: `tests/issue-1748.test.ts` (4 cases —
nested `readonly number[]`, `ReadonlyArray<number>`, `readonly string[]`,
plain control). IR fallback gate + tsc clean.
