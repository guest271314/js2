---
id: 1597
title: "host-indep: gate __throw_reference_error in standalone mode"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: tdz, error handling
goal: standalone-wasm
sprint: 55
related: [1471, 1473, 1474]
---
# #1597 — Gate `__throw_reference_error` in standalone mode

## Problem

`__throw_reference_error` is registered as a JS host import in three sites in
`src/codegen/expressions/identifiers.ts` with no `ctx.standalone` guard:

- Line 91 — TDZ violation on `let`/`const` before initialization
- Line 379 — unresolved identifier (dynamic reference error path)
- Line 663 — second TDZ path (destructuring / block-scoped binding)

In standalone/WASI mode, instantiation fails with `unknown import env::__throw_reference_error`.

## Fix

In standalone mode there is no JS exception system. The correct semantic is a
**Wasm trap** (`unreachable`) — a TDZ violation or unresolved identifier is a
programming error with no recovery path.

At each of the three `ensureLateImport(ctx, "__throw_reference_error", ...)` call
sites, add a `ctx.standalone` branch that emits `unreachable` instead of calling
the host import:

```ts
if (ctx.standalone) {
  fctx.body.push({ op: "unreachable" });
  return;
}
const throwRefErrIdx = ensureLateImport(ctx, "__throw_reference_error", ...);
fctx.body.push({ op: "call", funcIdx: throwRefErrIdx });
```

No host import is registered; no import appears in the output module.

## Files

- `src/codegen/expressions/identifiers.ts` lines 91, 379, 663

## Acceptance criteria

- `--target standalone` module with a TDZ violation compiles without registering
  `env::__throw_reference_error`.
- At runtime, accessing an uninitialized `let`/`const` traps (Wasm `unreachable`)
  rather than panicking at instantiation.
- `--js-host` default mode: no change — existing behaviour preserved.

## Effort

~20 LOC across 3 sites. No new types or helpers needed.
