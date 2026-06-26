---
id: 2719
title: "Array indexOf/includes/lastIndexOf on externref elements emit __host_eq/__same_value_zero with no standalone branch"
status: done
sprint: 67
created: 2026-06-26
updated: 2026-06-26
completed: 2026-06-26
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

- [x] externref-element `indexOf`/`includes`/`lastIndexOf` agree with host in
      standalone OR produce a tracked compile error — never an unsatisfiable
      import.

## Resolution (2026-06-26)

The three dedicated externref-element lowerings (`compileArrayIndexOf`,
`compileArrayIncludes`, `compileArrayLastIndexOf` in
`src/codegen/array-methods.ts`) now gate on `ctx.standalone || ctx.wasi`:

- **indexOf / lastIndexOf** → `ensureExternStrictEqHelper` (`__extern_strict_eq`,
  Strict Equality §7.2.16) instead of the host `__host_eq` import.
- **includes** → `ensureExternSameValueZeroHelper` (`__extern_same_value_zero`,
  SameValueZero §7.2.11) instead of the host `__same_value_zero` import.

These are the same pure-Wasm helpers (composed from `__any_from_extern` +
`__any_strict_eq`) already used by the `.call(...)` form
(`compileArrayLikePrototypeSearch`), so standalone search emits **zero host
imports**. Host/gc mode is byte-unchanged (still uses the host imports). The
funcIdx is re-resolved from `funcMap` by name after `flushLateImportShifts` so a
late-import shift can't desync the captured index.

Verified (`tests/issue-2719.test.ts`, 14 cases): standalone `indexOf` /
`includes` / `lastIndexOf` on `any[]` instantiate with empty imports and return
spec-correct results, including the NaN distinction (`includes(NaN)` → true via
SameValueZero, `indexOf(NaN)` / `lastIndexOf(NaN)` → -1 via Strict Equality);
host-mode results match. No new host imports. Pre-existing `#1360`
`lastIndexOf.call(arr, null)` null-field failures (tracked under #1382) are
unaffected — they live in the separate `.call` path and fail identically on
clean main.

**Out of scope (deferred):** the linear backend still has no externref-element
search lowering (hard compile error there) — the WasmGC standalone gap is what
parent #2711's parity gate flags; the linear-backend lowering is a separate
follow-up.
