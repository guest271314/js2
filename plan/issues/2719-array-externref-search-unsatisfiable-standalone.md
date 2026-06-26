---
id: 2719
title: "Array indexOf/includes/lastIndexOf on externref elements emit __host_eq/__same_value_zero with no standalone branch"
status: ready
sprint: 67
created: 2026-06-26
updated: 2026-06-26
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen
language_feature: standalone
goal: standalone-everything
parent: 2711
---
# #2719 — Array search methods unsatisfiable on externref elements in standalone

**Parent:** #2711 (standalone↔host differential parity gate).

## Root cause

The dedicated `indexOf` / `includes` / `lastIndexOf` lowerings for
externref-element arrays emit the host imports `__host_eq` /
`__same_value_zero` with **no standalone branch**
(`src/codegen/array-methods.ts:4034` / `:4262` / `:8648`). In standalone /
WASI those imports are unsatisfiable → module fails to instantiate. (The linear
backend has no lowering for these at all, so it is a hard compile error there —
also tracked here.)

## Fix sketch (per #2711 policy)

- Provide a Wasm-native equality / SameValueZero arm for the element type so
  standalone search does not depend on `__host_eq` / `__same_value_zero`.
- Until then, fail loud under `ctx.standalone` rather than emit the
  unsatisfiable import.

## Acceptance criteria

- [ ] externref-element `indexOf`/`includes`/`lastIndexOf` agree with host in
      standalone OR produce a tracked compile error — never an unsatisfiable
      import.
