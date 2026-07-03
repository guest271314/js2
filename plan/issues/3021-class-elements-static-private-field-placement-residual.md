---
id: 3021
title: "spec gap: class elements — static/private field & method placement residual (~1,522 default-lane fails)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, private-fields, class-elements
es_edition: 2022
goal: spec-completeness
test262_category: language/statements/class, language/expressions/class
test262_fail: 1522
related: [1047, 1144, 1226, 1348, 1364, 1365, 1591, 1643, 2669]
---

# #3021 — class elements: static/private field & method placement residual

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`, gitHash
`51622ba2`). Sub-bucketed from the `class/elements` (649) and `class/dstr`
(416) `error_category` buckets plus adjacent class-expression assertion
failures elsewhere in `language/{statements,expressions}/class` (~457 more),
total **1,522** official fails.

## Problem

A long line of class-element issues has landed (#1047 instance-fields-leak,
#1144 static-class-elements-this-priv, #1226 static-async-private, #1348/#1643
static-init-and-private-fields, #1364 method/field descriptor fidelity, #1591
same-line multi-definition) but a residual of the same *symptom family*
persists at a much larger scale than any single one of those fixes covered.
Dominant assertion signatures:

- `!Object.prototype.hasOwnProperty.call(C.prototype, 'x')` — **137** — a
  field or private/static element is still materializing as an own property
  of the constructor's `.prototype` object instead of the instance (or is
  visible on the wrong object entirely). This is the same symptom #1047
  fixed for one code shape; the residual suggests other shapes (nested
  static blocks, computed private names, multi-element same-line
  definitions) still leak.
- `c.foo === "X"` value mismatches — **73** — field initializer runs but
  produces the wrong instance value (ordering vs. superclass construction,
  or resolving against the wrong `this`).
- `c.m === C.prototype.m` identity checks — **63** — method reference
  identity broken, likely a re-materialization of the trampoline/closure
  per access instead of a stable function object.
- Remainder: destructuring inside class-element initializers and method
  params (`class/dstr`, 416) — generator/async-generator method params with
  destructuring defaults, closures over `this`/private names inside a
  destructured default expression.

## Sample failing files

- `language/statements/class/elements/multiple-stacked-definitions-static-private-methods.js`
- `language/expressions/class/dstr/gen-meth-ary-ptrn-elem-id-init-skipped.js`
- `language/statements/class/elements/after-same-line-static-gen-computed-symbol-names.js`

## Suggested approach

1. Re-run the `#1047` repro shape family (computed keys, static blocks,
   private names, same-line multi-definition) against current main and
   confirm which combinations still fail `hasOwnProperty` — the fix was
   scoped to `_wrapForHost` struct-field enumeration and may not cover every
   element-placement code path in the direct codegen (non-wrapForHost) class
   lowering.
2. For the `c.m === C.prototype.m` identity class, check whether method
   values are re-synthesized per property read instead of cached once on
   the prototype/instance struct.
3. `class/dstr` (416) likely shares root cause with the #2669 destructuring
   residual umbrella (which already tracks `for-of/dstr` 247, function-param
   dstr 63, object-method dstr 55) — cross-check before duplicating work;
   this issue owns the class-element-*specific* dstr shapes if #2669's
   scope doesn't already cover class method/constructor params.

## Acceptance criteria

- `hasOwnProperty(C.prototype, fieldName)` is false for every instance
  field/private-field shape test262 exercises.
- Method identity (`c.m === C.prototype.m`) holds across all class-element
  placement combinations.
- test262 fail count in `language/{statements,expressions}/class/{elements,dstr}`
  drops materially from the 1,522 baseline recorded above.
