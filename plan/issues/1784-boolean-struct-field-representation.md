---
id: 1784
title: "boolean i32 struct fields boxed as number — typeof/=== mismatch on dynamic read"
status: ready
created: 2026-06-03
updated: 2026-06-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-model
goal: spec-completeness
sprint: 58
related: [1461, 1130, 1644, 1472]
---
# #1784 - boolean i32 struct fields boxed as number — typeof / === mismatch on dynamic read

## Problem

A boolean property value stored in an object literal that lowers to a WasmGC
struct reads back as a **number** through any dynamic (host-visible) access
path. The boolean/number distinction is lost because the struct field is a
bare i32 and the field getter boxes it via `__box_number`.

```ts
const o: any = { x: true };
typeof o.x;                                   // "number"  (should be "boolean")
Array.prototype.indexOf.call({1:true,length:2}, true);  // -1  (should be 1)
```

Carved from **#1461** (Array.prototype.* on array-like receivers). #1461's
generic-receiver algorithm is correct and done; this is the one residual test
(`indexOf({1:true, length:2}, true)`), and it is a separate, lower-level
representation defect that also manifests with no array methods involved
(`typeof o.x`, `o[k] === true`).

## Root cause

WasmGC compiles a JS boolean to an i32. `ValType` has no boolean/number
discriminator on the `i32` variant (contrast: the `i64` variant already carries
`bigint?` from #1644). So a boolean field becomes an undistinguished i32:

1. `src/checker/type-mapper.ts` `mapTsTypeToWasm` maps `Boolean` /
   `BooleanLiteral` → `{ kind: "i32" }` (line ~49), dropping the boolean-ness.
2. Struct field defs (`FieldDef.type`, `src/ir/types.ts`) therefore can't tell
   a boolean field from a numeric one.
3. The `__sget_N` struct getter (`src/codegen/index.ts`
   `emitStructFieldGetters` / `buildGetterExtract`, ~line 1494-1645) boxes i32
   fields via `f64.convert_i32_s` + `__box_number`, turning the stored `true`
   into the JS number `1`. `__host_eq(1, true) === 0`, so indexOf returns -1;
   `typeof` then reports `"number"`.
4. Symmetric concern for the `__sset_N` setter
   (`buildSetterNestedIfElse`, same file ~line 1717): writing a boxed JS
   boolean back into an i32 field via the externref setter path must unbox a
   boolean, not a number.

## Proposed approach (architect to confirm)

Mirror the `i64.bigint` precedent:

1. Add `boolean?: true` to the `i32` ValType variant in `src/ir/types.ts`
   (`{ kind: "i32"; boolean?: true }`). Structurally compatible — every
   existing `.kind === "i32"` check still matches.
2. Tag it in `mapTsTypeToWasm` for `Boolean`/`BooleanLiteral` types, and
   wherever struct `FieldDef`s are built from TS types
   (`ensureStructForType` / struct field inference in `src/codegen/index.ts`).
3. In `buildGetterExtract`, route boolean i32 fields to `__box_boolean`
   instead of `__box_number`. **Wrinkle**: a struct whose field is purely
   boolean currently uses getter `returnMode: "i32"` (returns raw i32, no
   boxing). Boolean fields must force `returnMode: "extern"` so they box —
   the `allI32` / `returnMode` decision needs to special-case boolean.
4. Symmetric `__box_boolean` ↔ `__unbox_boolean` handling in
   `buildSetterNestedIfElse` for the boolean-tagged i32 setter path.
5. Confirm interaction with the plain-object `__extern_set` path in
   `src/codegen/literals.ts` (a localized boolean-boxing fix there resolves
   the accessor/spread plain-object variant; the struct path is the harder
   half — a unified fix at the representation layer covers both).

## Regression surface

Touches every struct that has a boolean field. `boolean`-typed locals,
params, and arithmetic are unaffected (they keep bare i32). Risk is confined
to struct field read/write boxing; CI test262 + equivalence gate it.

## Acceptance criteria

1. `typeof ({ x: true } as any).x === "boolean"`.
2. `Array.prototype.indexOf.call({1:true, length:2}, true) === 1` — the
   residual #1461 test (`tests/issue-1461.test.ts` line ~138) passes.
3. `({ x: true } as any).x === true` and `({ x: false } as any).x === false`.
4. No test262 / equivalence regressions on structs with boolean fields.

## Standalone relevance

This is part of the residual object-model representation work — sibling to
**#1472 Phase B** (Wasm-native open-object runtime). The struct-field boolean
tag is needed for faithful boolean round-tripping in standalone mode too, not
just JS-host. Coordinate with #1130 / #1644 / #1472 representation efforts.
