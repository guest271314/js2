---
id: 1716
title: "spec gap (RESIDUAL of #1090/#1525): 'Cannot convert object to primitive value' still thrown in 111 coercion paths"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: toprimitive-coercion
goal: test262-conformance
sprint: Backlog
es_edition: multi
test262_fail: 111
test262_category: built-ins/Object, built-ins/String, built-ins/RegExp, built-ins/JSON, built-ins/Date, built-ins/DataView
related: [1090, 1319, 1525, 1442]
---

# #1716 — ToPrimitive residual: 'Cannot convert object to primitive value' (111 fails)

## Problem (RESIDUAL / possible regression)

THREE closed issues already targeted this exact error string —
#1090 ("ToPrimitive 'Cannot convert object to primitive value' — 161 FAIL",
`done` 2026-04-14), #1319 ("Symbol.toPrimitive / valueOf / toString chain
incomplete — 234 failures", `done` sprint 56), and #1525 ("built-in coercion
paths throw eagerly", `done` 2026-05-28) — yet **111 tests still fail at runtime
with `Cannot convert object to primitive value`**. This is a residual (and
partly a regression-surface) of those closed issues — the fixes did not cover
every coercion site. #1319 was the most recent and broadest; the 111 here are
its residual.

Normalized signature: `runtime_error :: Cannot convert object to primitive value`.

### Distribution (actionable, Temporal/deferred excluded)

| Directory | Count |
|-----------|------:|
| built-ins/Object (getOwnPropertyDescriptor, create, defineProperty/-ies) | 39 |
| built-ins/String/prototype (trim/trimStart/trimEnd this-value coercion) | 26 |
| built-ins/RegExp/prototype (Symbol.split / Symbol.replace species/ctor) | 14 |
| built-ins/JSON (stringify replacer coercion) | 4 |
| built-ins/Date/prototype | 4 |
| built-ins/DataView | 4 |

## Root-cause hypothesis

The remaining sites are **ToPropertyKey / ToString of an object property key**
and **`this`-value ToString coercion** in built-in methods. When an object's
property key (or `this`) only defines `Symbol.toPrimitive` / `valueOf` /
`toString` returning a primitive — or returns an object so the next method must
be tried — our coercion helper throws immediately instead of walking the
OrdinaryToPrimitive method list (§7.1.1 ToPrimitive → §7.1.1.1
OrdinaryToPrimitive: try `valueOf` then `toString`, or the `@@toPrimitive`
exotic method first). #1090/#1525 fixed the *argument* coercion paths but not
the *property-key* (§7.1.19 ToPropertyKey → §13.2.4 PropertyDefinitionEvaluation)
and `this`-value (§22.1.3.x RequireObjectCoercible → ToString) paths.

Spec: [§7.1.1 ToPrimitive](https://tc39.es/ecma262/#sec-toprimitive),
[§7.1.1.1 OrdinaryToPrimitive](https://tc39.es/ecma262/#sec-ordinarytoprimitive),
[§7.1.19 ToPropertyKey](https://tc39.es/ecma262/#sec-topropertykey).

## Example failing tests

- `test/built-ins/String/prototype/trimStart/this-value-object-toprimitive-meth-priority.js`
  (asserts `Symbol.toPrimitive` is consulted before `toString`/`valueOf`)
- `test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-42.js`
  (object property key coerced via ToString)
- `test/built-ins/Object/create/15.2.3.5-4-235.js`
- `test/built-ins/RegExp/prototype/Symbol.split/species-ctor-ctor-non-obj.js`
- `test/built-ins/JSON/stringify/replacer-array-number-object.js`

## Acceptance criteria

- The five example tests above pass.
- The `Cannot convert object to primitive value` runtime-error bucket drops from
  111 to ≤ 30 (allowing for genuinely-deferred Temporal/Symbol edge cases).
- No regression in the previously-fixed #1090 / #1525 example tests.

## Notes

Flagged as a **residual/regression** of `done` issues #1090 and #1525 — higher
priority than a brand-new gap because the cause was supposedly fixed. Coordinate
with #1442 (String.prototype RequireObjectCoercible + ToString), which is in
`review` and overlaps the String subset; this issue owns the **Object
property-key** and **RegExp/JSON/Date** coercion sites #1442 does not.

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).
