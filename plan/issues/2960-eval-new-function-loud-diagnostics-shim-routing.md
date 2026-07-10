---
id: 2960
title: "eval / new Function: loud standalone diagnostics + call-time-throwing stub + host Tier-1 shim routing for dynamic new Function"
status: done
completed: 2026-07-02
assignee: ttraenkler/agent-dev-opus
sprint: 69
created: 2026-07-02
updated: 2026-07-03
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: eval
goal: runtime-eval
depends_on: [2924]
related: [1584, 2923, 2928, 1163]
origin: "2026-07-02 July Fable audit §4 (silent wrong-value stub in both modes; zero standalone diagnostic)"
---

# #2960 — dynamic code fails silently in both modes

## Problem (two verified defects)

1. **`new Function` with a non-constant body compiles to a silent no-op
   stub in BOTH modes**: arguments evaluated for side effects, then
   `ref.null.extern` (`src/codegen/expressions/new-super.ts:3175-3191`) —
   not a trap, not a diagnostic, a wrong value. ~119 host-mode
   Function-constructor test262 failures trace to this. #2924 (ready)
   covers only the constant-body compile-away.
2. **Standalone dynamic eval traps at instantiation with zero
   compile-time signal**: the fall-through lowers to `__extern_eval`
   (`src/codegen/expressions/calls.ts:4024-4025`) and the binary imports
   `env::__extern_eval` — the failure surfaces only when a host-free
   runtime rejects the import, with no source location. (The existing
   `refuseStandalone*` helpers show the right pattern; only opt-in
   hardened mode diagnoses today.)

## Scope

- **Host mode, dynamic `new Function`**: route to the existing Tier-1
  meta-circular runtime-eval shim (`src/runtime-eval.ts` — the same
  machinery indirect eval uses; `new Function(args, body)` is
  global-scoped, so no direct-eval scope-capture problem). Fixes the ~119
  cluster ahead of the #2928 interpreter.
- **Standalone, dynamic `new Function` + eval**: (a) emit a compile-time
  **warning diagnostic** on the `__extern_eval`/stub fall-through under
  `ctx.standalone || ctx.wasi` (source-located, names the runtime-eval
  goal + #2928); (b) replace the silent stub with a function value that
  **throws a catchable error at call time** ("dynamic code evaluation not
  supported in standalone mode") instead of returning undefined — a
  program that never calls the constructed function keeps working.
- Cleanup rider: delete-or-wire the inert `classifyEvalTier`
  (`src/codegen/eval-tiering.ts`, #1261 — zero callers).

## Acceptance criteria

- Host: `new Function("a","b","return a+b")(1,2) === 3` (dynamic path,
  LRU-cached shim); Function-ctor test262 cluster measurably up.
- Standalone: compiling `eval(x)` / dynamic `new Function` produces a
  warning naming the file:line; the emitted binary instantiates host-free
  and throws catchably at the call site.
- No new host imports without the standalone fallback above (dual-mode
  rule).

## Implementation Notes / Test Results (2026-07-02)

Delivered across `src/codegen/expressions/{eval-inline,new-super,calls}.ts`,
`src/codegen/context/types.ts`, `src/runtime-eval.ts`, `src/runtime.ts`:

- **Host dynamic `new Function`** → new `createNewFunctionShim` (runtime-eval.ts,
  wired as the `env::__extern_new_function` host import). It compiles the body as
  an EXPORTED function via `compileSourceSync` (the same meta-circular machinery
  indirect eval uses, LRU-cached) and returns a real JS-callable value — unlike
  the eval shim's child-module closure, which the parent can't cast/invoke.
  Codegen builds `(paramString, bodyString)` at runtime (ToString + `__concat_N`)
  and calls it. The immediate-call form `new Function(dyn)(args)` routes through
  the existing `__call_function` packer (`isFunctionCtorImmediateCall` guard).
- **Standalone/wasi dynamic `eval`** → source-located WARNING + catchable throw
  at the eval call site; NO `env::__extern_eval` leak (was an instantiation trap).
- **Standalone/wasi dynamic `new Function`** → WARNING + a call-time-throwing
  stub VALUE (hoisted `throw new Error(...)` closure). Construction succeeds, so a
  program that never invokes it keeps working; calling throws catchably.
- **Cleanup rider**: deleted the inert `classifyEvalTier` (`eval-tiering.ts`,
  #1261, zero production callers) + its test + the dead `evalTier?` ctx field.

Verified (`tests/issue-2960.test.ts`, 8/8):
- Host: `new Function("a","b","return a"+op+"b")(1,2) === 3` (dynamic immediate);
  constant immediate still `=== 3` (#2924 unchanged); dynamic value via
  `[..].map(f)` invokes the real callable (`=== 12`); `__extern_new_function`
  import present (no silent null stub).
- Standalone eval: no `__extern_eval` leak, warns, host-free instantiable, throws
  catchably (try/catch → 42).
- Standalone `new Function`: warns, host-free, construction returns 7; a later
  call throws catchably (try/catch → 99).
- Byte-inert: 5 non-eval programs compile sha256-identical to `origin/main`.
- `tests/issue-2923-eval-const-broaden.test.ts` `bailsToDynamic` helper updated
  for the new no-leak/warn signature (17/17).

**Known pre-existing (out of scope, fails identically on `origin/main`)**: the
`(eval as any)()` / `(X as any)()` parenthesized-cast-callee immediate-call
shape overflows the compiler stack (`tests/issue-1006.test.ts` &
`tests/issue-1163.test.ts` "eval with no arguments"). Also, calling a host-JS
function held in an `any` variable directly from wasm (`const f: any = …; f(x)`)
returns undefined — the general any-callee host-function dispatch limitation;
the shim value still works via immediate-call and host consumers.
