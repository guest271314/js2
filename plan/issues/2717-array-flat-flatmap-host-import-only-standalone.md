---
id: 2717
title: "Array flat/flatMap are host-import-only — no standalone native arm, no ctx.standalone guard"
status: ready
sprint: 66
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen
language_feature: standalone
goal: standalone-everything
parent: 2711
---
# #2717 — Array.prototype.flat / flatMap have no standalone arm

**Parent:** #2711 (standalone↔host differential parity gate). **Surfaced by**
the cross-backend harness: `[[1,2],[3,4]].flat()` does not compile/run on the
linear (standalone) backend.

## Root cause

`flat` / `flatMap` call `ensureLateImport("__array_flat" / "__array_flatMap")`
with **no `ctx.standalone` guard and no native (Wasm-only) arm**
(`src/codegen/array-methods.ts:8748` / `:8790`). In WASI / standalone there is
no JS host to satisfy that import, so the module **fails to instantiate** (and
the linear backend has no lowering at all → compile error). Host mode works
because the import is satisfied.

## Fix sketch (per #2711 policy)

- Add a Wasm-native lowering for `flat`/`flatMap` over WasmGC array element
  types, gated so standalone uses it.
- Until the native arm exists, the standalone/WASI path must **`reportError`
  (fail loud)** rather than emit an unsatisfiable import that traps at
  instantiate time — the #2711 fail-loud policy.

## Acceptance criteria

- [ ] `flat`/`flatMap` either compile+run in standalone (agree with host on the
      cross-backend corpus) OR produce a tracked compile error — never an
      unsatisfiable late import.
