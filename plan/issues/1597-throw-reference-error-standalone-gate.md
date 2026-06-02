---
id: 1597
title: "host-indep: gate __throw_reference_error in standalone mode"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
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

## Resolution (2026-05-24)

All three call sites in `src/codegen/expressions/identifiers.ts`
(`emitLocalTdzCheck`, `emitStaticTdzThrow`, and the unresolved-identifier
path in `compileIdentifier`) are **already gated** by `noJsHost(ctx)`
(`ctx.wasi || ctx.standalone`) as a consequence of the #1473 errors/exceptions
host-independence work. In no-JS-host mode they build a ReferenceError
*instance* in-module and trap (`unreachable`) — strictly better than the bare
`unreachable` the spec sketched, since `e instanceof ReferenceError` works
under wasmtime. No host import is registered.

Empirically verified against current main:

- `--target standalone` TDZ violation and unresolved-identifier modules
  compile with **zero** env imports (no `__throw_reference_error`).
- Standalone module instantiates with `{}` imports — no panic at
  instantiation. A try/catch-wrapped TDZ access catches the in-module
  ReferenceError.
- `--target wasi` likewise omits the import.
- Default (gc / JS-host) mode is unchanged — import still present.

The remaining deliverable for this issue is the regression-guard test
`tests/issue-1597-standalone-reference-error.test.ts`, which pins all four
of the above behaviours so the dual-mode gating cannot silently regress.
No source change was required.
