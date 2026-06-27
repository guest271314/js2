---
id: 2712
title: "Introduce a real bool ValType; retire the optional i32 boolean brand"
status: ready
sprint: 67
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

## Architect scope-read (esch, 2026-06-27) — needs a fuller spec before dispatch

**Verdict: NOT plain-dev-able. Needs a short architect addendum (a representation
decision + a switch-site sweep), then senior-dev-able.** The issue body lists the
5 boxing drop-sites correctly, but the framing "the way `bigint` already has a
typed i64 lane" understates the blast radius. The current `ValType` union
(`src/ir/types.ts:146-160`) is:
```ts
| { kind: "i32"; boolean?: true }
| { kind: "i64"; bigint?: boolean }    // bigint is ALSO an optional brand, not a separate kind
```
So **`bigint` is NOT a separate `{kind:"bigint"}`** — it is the same optional-brand
shape this issue wants to retire for booleans. Promoting boolean to a first-class
`{kind:"bool"}` therefore introduces a *genuinely new kind*, not a mirror of an
existing one.

The load-bearing design decision the architect must settle first: **a `bool` value
is physically an `i32` in wasm** (locals, `i32.eqz`/branches, comparisons, struct
fields all stay i32). So `{kind:"bool"}` must be treated as i32 by every low-level
site (local allocation, the emitter's `case "i32"`, arithmetic/branch lowering,
field storage) but as bool by the boxing/coercion/property-key/SameValueZero sites.
That means a `bool` arm is needed at MANY more `switch (vt.kind)` sites than the 5
listed — the spec must enumerate the full sweep (emitter encoding, `resolveWasmType`,
local/global type mapping, `coerceType` both directions, struct field types,
function param/result types) and define which fall through to the i32 path vs. take
a distinct bool path. Recommend the architect (or the senior dev, inline) produce
that switch-site inventory + the physical-rep contract as a `## Implementation Plan`
before code starts; the 5 drop-sites are the *acceptance* surface, not the *change*
surface. Already `[SENIOR-DEV]` (task #3) — keep it there; do not hand to a plain dev.

Cross-link: **#2732(b) `true === 1` depends on this** (see #2732 scope-read) — the
strict-equals type-tag distinction between boolean and number is unrepresentable
until the bool lane exists.
