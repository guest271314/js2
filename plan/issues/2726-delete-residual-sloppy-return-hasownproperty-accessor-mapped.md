---
id: 2726
title: "delete residual: sloppy return-value semantics, hasOwnProperty-after-delete, accessor descriptor configurability, mapped-arguments delete"
status: ready
sprint: 67
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: ES5
language_feature: delete
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2726 — delete residual (non-throw) semantics

Split out of #2703, which delivered the **throw** cases of `delete`
(super → ReferenceError, null/undefined base → TypeError, strict non-configurable
→ TypeError). The remaining `delete` test262 failures are **non-throw** concerns
that each need a distinct subsystem fix; they are tracked here so #2703 can close
on its throw-semantics scope.

## Sub-groups (14 tests, all `test/language/expressions/delete/` unless noted)

### (a) Sloppy-mode `delete <unresolvable identifier>` → `true` (3)
`S11.4.1_A2.2_T1.js`, `S11.4.1_A3.3_T6.js`, `11.4.1-3-1.js`
- `delete x` where `x` resolves to **no binding anywhere** returns `true` in
  sloppy mode (§13.5.1.2: unresolvable Reference ⇒ true). We currently return
  `false` for every bare identifier (variables-not-deletable path in
  `compileDeleteExpression`).
- **Hazard**: a naive "unknown to the compiler ⇒ unresolvable ⇒ true" flip
  regresses `delete NaN`/`delete undefined`/`delete Infinity` (real
  non-configurable globals ⇒ must stay `false`). Needs a reliable
  "is this a real global binding" oracle, not the `isUnresolvableIdent`
  compiler-knowledge heuristic.

### (b) Sloppy global-object model (4)
`S11.4.1_A3.1.js` (#2 `delete this.y === false`), `S11.4.1_A3.2_T1.js`
(`x = 1; delete x === true` — implicit global), `S11.4.1_A3.3_T1.js`
(`delete x; x` then ReferenceError), `11.4.1-4.a-8.js` (`delete JSON === true`).
- Requires modelling top-level `this` as the global object and tracking
  `var`/function-declared globals as non-configurable vs implicitly-created
  globals as configurable. Structural; likely architect-spec first.

### (c) `hasOwnProperty` false after a configurable `Object.defineProperty` delete (3)
`11.4.1-4.a-1.js`, `11.4.1-4.a-2.js`, `11.4.1-4-a-4-s.js`
- After `delete obj.prop` of a `configurable:true` defineProperty'd property,
  `obj.hasOwnProperty("prop")` still reports `true`. The `__delete_property`
  tombstone (`_wasmStructDeletedKeys`) / `__hasOwnProperty` predicate is not
  clearing the property for these struct shapes. ~27 sibling fails in
  `built-ins/Object/defineProperty/15.2.3.6-3-*.js` share this root cause.

### (d) Non-configurable accessor descriptor not consulted by delete (1+)
`11.4.1-4-a-2-s.js`
- `delete obj.prop` of a **non-configurable accessor** wrongly returns `true`
  (host `__delete_property` does not see the accessor's `configurable:false`
  flag). Runtime descriptor-storage fix in `src/runtime.ts`.

### (e) Mapped-arguments delete (1)
`11.4.1-4.a-17.js`
- `delete arguments[0]` in a mapped-arguments function: `=== true` and the slot
  reads `undefined` afterward. Routes through the `mappedArgsInfo` bookkeeping in
  `compileDeleteExpression` plus the element-delete on `arguments`.

### (f) preventExtensions interaction (1)
`11.4.1-5-a-27-s.js`
- Not really a delete bug: after `delete a.x; Object.preventExtensions(a)`, a
  strict-mode `a.x = 1` must throw (assign to a property of a non-extensible
  object). Belongs with strict-mode assignment / preventExtensions support.

### (g) Prototype-chain read (1)
`S8.12.7_A2_T2.js`
- Fails at the inherited-property *read* (`__palette.red`), before the delete —
  a prototype-chain read gap, not a delete bug.

## Acceptance

The (a)–(e) groups flip from fail to pass with no regression in
`expressions/delete/` or `built-ins/Object/defineProperty/`. (f) and (g) may be
re-routed to their owning feature issues. Full CI green.
