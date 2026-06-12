---
id: 1978
title: "user function named main gets the module-init body spliced into it: top-level state resets on every call; WASI infinite recursion for main() convention"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: modules
goal: core-semantics
related: [900, 907, 1122, 1789]
origin: "2026-06-10 deep-audit sweep (optimizer agent): verified on main"
---

# #1978 — `main` name collision with the synthetic init function

## Problem

**A (silent, default GC target):**

```ts
let counter = 0;
export function main(): number { counter = counter + 1; return counter; }
```

Three host calls of `main()` → wasm `1, 1, 1` — node `1, 2, 3`. Module-global
initializers re-execute on every call. Renaming `main`→`run` → correct.

**B (WASI):** `function main(): void { console.log(42); } main();` with
`{ target: "wasi" }` → `RangeError: Maximum call stack size exceeded` (WAT
shows `$main` beginning with a call to its own index); node prints `42`. The
conventional `main()` program shape is unrunnable on WASI.

## Root cause

`src/codegen/declarations.ts:3995-4011` — when injecting compiled top-level
statements, if a function named `main` exists its body is *prepended* with the
init body (`mainFunc.body = [...init, ...mainFunc.body]`) instead of creating
a separate `__module_init`. The init body includes module-global initializers
(re-executed per call → state reset) and any top-level `main()` call
(→ self-recursion). The `__init_done` idempotency guard
(`applyModuleInitGuard`, index.ts:1577) only guards a function literally named
`__module_init`; `addWasiStartExport`'s `main` fallback (index.ts:1633) is
moot because the bug is the splice itself.

## Fix direction

Drop the `main`-splice special case — always emit a standalone `__module_init`
(the `else` branch at declarations.ts:4013 already handles start-section/WASI
correctly); if `main`-as-entry must be preserved, wrap with a guarded init
call rather than splicing the raw body.

## Acceptance criteria

- Repro A returns `1, 2, 3` across calls
- Repro B runs once and exits on WASI
- Programs without a `main` unregressed (start section/init ordering intact)

## Resolution

Removed the `main`-splice special case in `injectModuleInit` (the tail of
`compileDeclarations`, `src/codegen/declarations.ts`). The init body is now
*always* emitted as a standalone `__module_init` run once via the Wasm start
section (or, for WASI, the `_start` export `addWasiStartExport` builds) —
exactly the `else` branch that already existed for the no-`main` case. A user
function named `main` is treated as an ordinary export and receives no init
treatment, so:
- module-global initializers run exactly once (at instantiation), not on every
  `main()` call, and
- the `main()`-calls-itself convention no longer prepends a call to `main`'s own
  index → no self-recursion.

The now-dead `shiftLocalIndices` helper (only the removed splice used it) was
deleted.

## Test Results

`tests/issue-1978.test.ts` — 5 cases: repro A (state persists `1,2,3`), a
once-only top-level initializer, the WAT shape (start section + `__module_init`,
no splice / no `__init_done`), repro B (WASI compiles with `_start`, no
self-recursion), and a no-`main` control. All pass. `tests/issue-907.test.ts`:
the one stale test that asserted the OLD spliced behaviour was updated to assert
the start-section behaviour; 7/8 pass (the lone remaining failure — "WASI keeps
_start … does NOT use start section" — is **pre-existing on main**, unrelated to
this change). `tests/issue-1789-standalone-module-init.test.ts` + the
`global-*` equivalence tests stay green.

## Dupe check

#900 (missing-main handling), #907 (`__init_done`→start-section), #1122,
#1789 (init-before-exports) — all done, adjacent, none cover the
name-collision splice. Unfiled.
