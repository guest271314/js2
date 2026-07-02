---
id: 2924
title: "new Function(\"<const>\") compile-away MVP — replace the no-op stub"
status: ready
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval
goal: runtime-eval
sprint: current
parent: 1584
depends_on: [2923]
related: [1163, 1584]
---

# #2924 — `new Function("<const>")` compile-away MVP

Slice **B** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-B, §4.4).
Second landable slice — pure AOT, **standalone-safe**, no interpreter.

## Problem

`new Function(...)` / `Function(...)` currently lowers to a **no-op stub**
(`src/codegen/expressions/new-super.ts` ~line 3179): it evaluates the arguments
for side effects and returns `ref.null.extern` — a "function" that returns
`undefined`. Every test that actually *calls* the constructed function fails
(119 `new Function(` tests fail today, roadmap §5.2), and standalone gets
nothing.

## Key semantic (why this is easier than eval)

Per **§20.2.1.1** `Function(p1, …, pn, body)`, the created function's scope is
**always the global environment** — it never captures the caller's lexical
scope. So there is no environment-reification problem here (that is eval's
Tier-2/§4.1 concern). When the parameter list and body are compile-time
**constant** strings, `new Function("a","b","return a+b")` is semantically
identical to compiling `function (a,b){ return a+b }` at that site.

## Goal

Replace the no-op stub with a compile-away path:

1. Detect the constructor callee is the global `Function` (mirror
   `isGlobalEvalIdentifier` in `eval-tiering.ts` — a `Function` identifier
   resolving only to the `.d.ts` lib declaration, not a local shadow).
2. Resolve each argument with `resolveConstantString` (from `eval-inline.ts`).
   If **all** are constant: the last is the body, the rest are the parameter
   list (comma-split, per §20.2.1.1.1 CreateDynamicFunction).
3. Synthesize `function (<params>) { <body> }` as a foreign SourceFile (reuse
   the #2923-broadened splice machinery) and emit it as a real AOT function
   value (a `funcref`/closure over the **global** scope only).
4. Non-constant arguments keep falling through to the existing path (host import
   today, the Tier-2 interpreter in #2928).

## Edge cases

- **`Function()` no args** → `function anonymous() {}` (empty body). Returns a
  callable that returns `undefined` — but a *real* callable, not `ref.null`.
- **Multiple param strings** — `new Function("a", "b,c", "return a+b+c")`:
  params flatten across args (`a`, `b`, `c`).
- **Body parse error** → real JS throws `SyntaxError`. Emit the compile-time
  error (matches negative tests) rather than silently returning null.
- **`new` vs plain call** — `Function(...)` and `new Function(...)` are
  equivalent (§20.2.1.1); handle both callee shapes.
- **No lexical capture** — the synthesized function must NOT close over caller
  locals (global scope only). Verify a name used in the body that is a caller
  local resolves as a **global**, not the caller's binding.

## Acceptance criteria

- [ ] `new Function("a","b","return a+b")(1,2) === 3` in **standalone** mode.
- [ ] `Function("return 42")() === 42` (plain call form) standalone.
- [ ] `new Function("a", "b,c", "return a+b+c")(1,2,3) === 6` standalone.
- [ ] A body referencing a caller local resolves it as a global (no capture).
- [ ] `new Function("return")()` returns `undefined` via a real callable.
- [ ] No regression in existing `new Function` tests.

## Notes

Dynamic-body `new Function` (runtime-computed strings) is deferred to the Tier-2
interpreter (#2928). Umbrella: #1584. Goal: `runtime-eval`.
