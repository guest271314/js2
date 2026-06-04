---
id: 1821
title: "delete obj.prop always returns true; delete obj['k'] skips __delete_property sidecar"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1821 — `delete` struct fast-path defects

## Symptom
- `delete obj.nonConfigurable` returns `true` (spec: `false`, strict throw).
- `delete obj["x"]` and `delete obj.x` diverge: only the property-access form
  removes the `Object.defineProperty` descriptor, so `hasOwnProperty("x")` differs.

## Location
`src/codegen/typeof-delete.ts:127-185` drops `__delete_property`'s result and
pushes `i32.const 1`. `:192-214` (element-access arm) omits the `__delete_property`
sidecar that the property-access arm performs (added #1334). The general path
(`:216-291`) correctly returns the helper result.

## Spec
ECMAScript §13.5.1.

## Fix
Return the `__delete_property` result for struct fields; mirror the sidecar in the
element-access arm.

