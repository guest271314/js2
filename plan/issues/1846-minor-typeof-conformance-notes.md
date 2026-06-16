---
id: 1846
title: "Minor typeof conformance: i64->'number' in with-bindings; externref->null fallthrough"
status: backlog
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: low
task_type: bugfix
area: codegen
goal: correctness
sprint: Backlog
---
# #1846 — minor `typeof` conformance notes

## Defects
- `src/codegen/typeof-delete.ts:831` (`staticTypeofForWasmType`) maps i64 → "number"
  instead of "bigint" — reachable only via `with`-bindings, near-nil impact.
- `:684-690` the externref branch can `return null` for some non-undefined object
  operands (low confidence; verify against union operands).

## Spec
ECMAScript §13.5.3 typeof table.

## Fix
Add `if (kind==="i64") return "bigint"` before the f64 case; ensure the externref
branch returns "object" (or routes to runtime) for known non-undefined objects.

