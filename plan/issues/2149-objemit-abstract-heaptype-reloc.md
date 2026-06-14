---
id: 2149
title: "standalone object emit: `Object emit error: u32 out of range: -19` — abstract heap-type typeIdx emitted as a relocation symbolIndex"
status: done
sprint: Backlog
created: 2026-06-14
updated: 2026-06-14
completed: 2026-06-14
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, emit
language_feature: any, equality
goal: standalone-mode
related: [2029, 2081, 1842]
origin: "Surfaced by dev-c during #2081 standalone loose-eq work: a function with any-typed params (`function eq(a:any,b:any){return a==b}`) fails relocatable-object compilation (`compileToObject`, --target standalone) with `Object emit error: u32 out of range: -19`, blocking #2081 reproduction."
---

# #2149 — object emit: abstract heap-type typeIdx serialized as a reloc symbolIndex

## Problem

`compileToObject(src, { target: "standalone" })` (the relocatable `.o`
emitter) throws `Object emit error: u32 out of range: -19` for any function
that uses any/any equality, e.g.:

```ts
export function eq(a: any, b: any): boolean { return a == b; }
```

`compile()` (the `emitBinary` path) compiles the same source fine — only the
**object emitter** (`src/emit/object.ts`) fails. `a:any == 1` (one numeric
operand) does NOT fail; the trigger is the **any/any** equality dispatch.

## Root cause

The any-equality / AnyValue path emits `ref.test` / `ref.cast` / `ref.null`
instructions whose `typeIdx` is a **negative abstract heap-type sentinel**.
`eq` is encoded as `-19` — `EQ_HEAP_TYPE = -19` in
`src/codegen/any-helpers.ts` (the signed-LEB heap-type byte `0x6d`). Abstract
heap types (`eq`, `any`, `func`, `i31`, …) are encoded INLINE as a single
signed-LEB byte; they are not concrete module type indices.

`emitBinary` encodes them correctly via `enc.i32(typeIdx)`. But the object
emitter (`encodeInstrWithReloc` in `object.ts`) **unconditionally** pushed a
type-index relocation for `ref.test` / `ref.cast` / `ref.cast_null`:

```ts
relocs.push({ type: RELOC.R_WASM_TYPE_INDEX_LEB, offset: enc.position, symbolIndex: instr.typeIdx });
enc.i32(instr.typeIdx);
```

When `instr.typeIdx` is `-19`, the inline `enc.i32` is fine, but the reloc
entry carries `symbolIndex: -19`. Serializing the `reloc.CODE` section then does
`s.u32(-19)` → `RangeError: u32 out of range: -19` (object.ts:294, the
`reloc.CODE` symbolIndex write). `ref.null` already (correctly) emitted no
reloc, which is why only the `ref.test`/`ref.cast` arms tripped.

## Fix

In `src/emit/object.ts`, skip the `R_WASM_TYPE_INDEX_LEB` relocation for
`ref.test` / `ref.cast` / `ref.cast_null` when `instr.typeIdx < 0` — a negative
typeIdx is an abstract heap type encoded inline, not a relocatable concrete
module type. `enc.i32(typeIdx)` still writes the correct signed-LEB byte.
`struct.*` / `array.*` ops (which use `enc.u32` and always take concrete types)
are unaffected.

## Acceptance criteria

- `compileToObject(`any/any `==`/`===`/`!=`, { target: "standalone" })` succeeds
  (no `u32 out of range: -19`).
- Concrete-type relocations (object literal / class / array `struct.new`,
  `ref.cast` to a defined struct) still emit their `R_WASM_TYPE_INDEX_LEB`
  relocs — verified by the existing `tests/object-file.test.ts` (12 passing) +
  the regression case in the new test.
- `emitBinary` output unchanged.
- Unblocks #2081 standalone loose-eq reproduction.

## Test

`tests/issue-objemit-abstract-heaptype.test.ts` — 5 cases: any/any
loose/strict/inequality object emit; any param compared then called; and the
concrete-type-reloc regression guard.
