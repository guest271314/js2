---
id: 1989
title: "ToPrimitive valueOf dispatch keyed by struct type name, not object identity — last same-shape literal's valueOf wins for ALL coercions"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1937, 2009, 1971]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1989 — static valueOf resolution collides across same-shape object literals

## Problem

```ts
const a: any = { valueOf() { return 7; } };
const b: any = { valueOf() { return 100; } };
String(a + 1) + "," + String(b + 1)
// wasm: "101,101"   node: "8,101"
```

Cross-function variant: three separate exported functions with objects
carrying `valueOf`→2, `valueOf`→7/100, and `toString`→"T" ALL coerce via
the last-compiled literal's method — even the `{toString}` object.

## Root cause

`src/codegen/type-coercion.ts:1762-1768` and `:1903-1930` — the ref→f64
static valueOf dispatch is keyed by struct **type name**
(`fields.findIndex("valueOf")`, `ctx.funcMap.get(\`${name}_valueOf\`)`,
`ctx.valueOfClosureTypes.get(name)` registered at
`src/codegen/literals.ts:1360-1364`). Distinct literals sharing a Wasm
struct shape share the name, so every coercion resolves to the
last-compiled literal's method instead of the funcref actually stored in
the object.

## Fix direction

Dispatch through the funcref field stored in the struct instance
(`call_ref` on the object's own valueOf slot) rather than a name-keyed
static lookup. Same disease family as #2009 (field-name export keyed by
canonicalized typeIdx).

## Acceptance criteria

- Both repros match Node; per-object valueOf/toString respected
- Mixed valueOf/toString objects pick their own method per hint

## Dupe check

#1937 is the static-analysis-ignores-dataflow sibling for Math.min/max;
#1971 doesn't mention valueOf. Older valueOf issues (#1090/#1253/#1319)
done. New.
