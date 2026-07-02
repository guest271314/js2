---
id: 2960
title: "eval / new Function: loud standalone diagnostics + call-time-throwing stub + host Tier-1 shim routing for dynamic new Function"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
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
