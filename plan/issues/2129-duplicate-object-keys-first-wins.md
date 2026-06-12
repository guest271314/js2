---
id: 2129
title: "duplicate object-literal keys resolve first-wins instead of last-wins"
status: ready
sprint: 61
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: low
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [140, 1239]
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2129 — duplicate object-literal keys: last property definition must win

## Problem

When an object literal repeats a key, the compiler keeps the first value; ES
semantics require the **last** definition to win (each duplicate runs in source
order and overwrites the previous, so the final value is observed).

```ts
({ a: 1, a: 2 }).a            // wasm: 1    node: 2
({ a: 1, b: 9, a: 3 }).a      // wasm: 1    node: 3
```

## Root cause (pointer)

Object-literal struct layout deduplicates property names but binds the field
to the **first** initializer rather than the last. The fix is to let a later
property with the same name override the earlier slot's initializer (while
still evaluating all initializers in source order for their side effects). See
object-literal field collection in `src/codegen/object-ops.ts`.

## Spec

ECMAScript §13.2.5.5 PropertyDefinitionEvaluation runs each
PropertyDefinition in order; `PropertyDefinition : PropertyName : Assignment`
calls `CreateDataPropertyOrThrow`, which a later same-key definition
overwrites. Side effects of all initializers still occur.

## Acceptance criteria

- `({ a: 1, a: 2 }).a` → `2`
- `({ a: 1, b: 9, a: 3 }).a` → `3`
- All initializer side effects in a duplicate-key literal still run in order
  (e.g. `{ a: sideEffect1(), a: sideEffect2() }` runs both)
- An equivalence test under `tests/`

## Notes

Verified on main `c19a2e9c1` via `.tmp/triage.mts` / `.tmp/triage2.mts`
(branch `po-1971-triage`). Likely XS-to-S — single layout fix plus
side-effect ordering. JS-host mode, default options.
