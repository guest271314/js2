---
id: 1788
title: "boolean i32 struct fields boxed as number — typeof/=== mismatch on dynamic read"
status: done
created: 2026-06-03
updated: 2026-06-03
completed: 2026-06-03
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

## Implementation notes (sd-1665, 2026-06-03)

Implemented as the mirror of the `i64.bigint` precedent (#1644). Four touch
points, all gated on the new brand so non-boolean codegen is byte-identical:

1. **`src/ir/types.ts`** — `{ kind: "i32"; boolean?: true }`. Structurally
   inert: every existing `.kind === "i32"` check still matches, so boolean
   locals / params / arithmetic keep bare-i32 codegen.
2. **`src/checker/type-mapper.ts`** `mapTsTypeToWasm` — tag `Boolean` /
   `BooleanLiteral` → `{ kind: "i32", boolean: true }`. This single point
   covers struct fields (they resolve through `resolveWasmType`, which
   delegates primitives to `mapTsTypeToWasm`) **and** the value-coercion
   path, so `JSON.stringify(true)` now correctly yields `"true"` (was `"1"`)
   because the i32→externref coercion site routes a branded i32 through
   `__box_boolean`.
3. **`src/codegen/index.ts` `fieldsHashKey`** — boolean-branded i32 fields hash
   as `i32:bool`, distinct from numeric `i32`. **Why this matters:** the
   structural dedup key only used `.kind` (both box as i32 at the Wasm type
   level), so `{ x: true }` and `{ x: 1 }` would collapse to one struct and the
   getter would inherit whichever boxing was registered first. Splitting the
   key keeps the per-field getter-boxing decision sound. The two structs are
   identical at the Wasm type level (both i32) — only their getters differ — so
   the extra type index is harmless.
4. **`src/codegen/index.ts` getter emission** — two coupled changes:
   - the `returnMode` decision forces externref/box mode (`hasBool`) for any
     all-i32 bucket that contains a boolean field. The raw-`i32` returnMode
     returns a bare i32 the host reads back as a *number*; a boolean must box.
   - `buildGetterExtract` routes a boolean-branded i32 field through the
     existing `__box_boolean` import instead of `f64.convert_i32_s` +
     `__box_number`.

**Scope deliberately getter-only.** The setter side is already correct: a
pure-boolean field bucket uses the `i32` valMode setter `(externref, i32)`, and
the WebAssembly JS API coerces a passed `true` → 1 via ToInt32. Mixed
boolean+ref buckets fall to the sidecar (skipped) exactly as before — no
regression, no new setter path needed.

**Regression check.** Equivalence suites covering structs / objects / typeof /
ternary / logical / classes pass. The only behavioural change is the
(correct) `JSON.stringify(true/false)` → `"true"`/`"false"`; that suite's two
assertions were updated (they previously pinned the `"1"`/`"0"` bug as a known
limitation). The residual #1461 `indexOf({1: true, length: 2}, true) === 1`
test (`tests/issue-1461.test.ts`) was flipped from `it.fails` to `it` and now
passes. Verified that the object-mutability `isFrozen`/`isSealed`/`isExtensible`
and object-literal-setter / void-isNaN equivalence failures are **pre-existing
on clean `origin/main`** (built and ran the baseline), not caused by this
change. Tests: `tests/issue-1788.test.ts` (6 cases) + the flipped #1461 case.
