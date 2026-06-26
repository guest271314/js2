---
id: 2712
title: "Introduce a real bool ValType; retire the optional i32 boolean brand"
status: ready
sprint: 66
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: value-representation
goal: value-rep-substrate
related: [1788, 1917, 2580]
---
# #2712 — Real bool ValType; retire the optional i32 boolean brand

**Source:** 2026-06-26 audit. Recurring "bug factory" #2: representation
collision. `{kind:"i32"}` simultaneously means **number**, **boolean**, and
**char-code**. Booleanness is carried as an *optional* side-channel brand
(`{kind:"i32", boolean:true}`, `src/checker/type-mapper.ts`) that **every boxing
site must remember to consult** — and several don't.

## Problem

#1788 (done) added `__box_boolean` and the brand for the dynamic-getter path, but
the brand is dropped at multiple boxing sites, so a boolean reifies as the
*number* 1/0:

- `Object.values`/`Object.entries` box a boolean field as `1`/`0`
  (`object-ops.ts:4000-4003`, `:4059-4063`) → `Object.values({a:true})[0]===true`
  is false; `typeof` is `"number"`.
- Map/Set key coercion boxes boolean keys as numbers (`map-runtime.ts:1204-1212`);
  `__same_value_zero` has no boolean arm → `new Set([true]).has(1)` wrongly true.
- `__to_property_key` has no boolean arm (`object-runtime.ts:459-502`) → `o[true]`
  keys `"1"` not `"true"`; a null/undefined computed key hits a non-null
  `ref.cast $AnyString` and **traps**.
- `coerceType` i32→externref drops the brand (`type-coercion.ts:1525-1537`) even
  though the adjacent i64→externref arm honours the analogous `bigint` brand.

Any *new* i32→externref site is a latent boolean-as-number bug. The brand is the
wrong shape: optionality means correctness depends on memory, not on types.

## Recommendation

Promote boolean to a **first-class ValType** (`{kind:"bool"}`), the way `bigint`
already has a typed i64 lane. Then:

- boxing dispatches on the ValType (`bool` → `__box_boolean`) — unrepresentable to
  "forget the brand";
- `__same_value_zero`, `__to_property_key`, `Object.values/entries`,
  `coerceType`, and the descriptor reify path each gain a `bool` arm by
  construction (the type forces the switch to be exhaustive);
- the i32 lane reverts to meaning *number/char-code* only.

This is value-rep substrate work — coordinate with #1917 (single coercion engine)
and the #2580 substrate spine so the bool lane lands once, centrally.

## Acceptance criteria

- [ ] A `bool` ValType exists; the checker emits it where it currently emits
      `{kind:"i32", boolean:true}`.
- [ ] All boxing/coercion/property-key/SameValueZero sites dispatch on `bool`;
      the optional `boolean:true` brand is removed.
- [ ] `Object.values({a:true})[0]===true`, `new Set([true]).has(1)===false`,
      `o[true]` keys `"true"`, `o[null]` keys `"null"` (no trap) — all in both
      host and standalone modes.
- [ ] Equivalence + test262 non-regressing; full-CI / merge_group (broad impact).
