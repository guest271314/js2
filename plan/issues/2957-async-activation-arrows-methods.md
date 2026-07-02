---
id: 2957
title: "Async activation for arrows / methods / function expressions (both CPS + drive hooks are declaration-only)"
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
language_feature: async
goal: async-model
related: [1796, 2906, 1042, 2612]
origin: "2026-07-02 July Fable audit §2 (both activation hooks require ts.isFunctionDeclaration)"
---

# #2957 — async arrows, methods, and function expressions never activate a state machine

## Problem

Both async activation hooks gate on `ts.isFunctionDeclaration`
(`src/codegen/function-body.ts:1163` — WASI drive layer, `:1185` — JS-host
CPS). An `async` arrow function, class method, object-literal method, or
named/anonymous function expression therefore always falls to the legacy
synchronous pass-through model, even when its body is exactly the canonical
shape `asyncFnNeedsCps` / `asyncFnNeedsDrive` would accept. This silently
caps both the host CPS lane and the standalone drive lane to a syntactic
subset; test262 async tests overwhelmingly use arrows and methods.
(#2612 covers the call-site side only; no issue covered activation.)

## Approach

1. Factor the activation predicate to accept any function-like node with a
   body (`ts.isFunctionLike` minus constructors/accessors), threading the
   correct name/slot context for each shape (arrows capture `this`
   lexically — verify interaction with the closure capture machinery;
   methods carry the class-shape typeIdx parity contract).
2. Land per-shape, measuring each: function expressions → arrows → methods
   (riskiest last: interacts with #1370 class registry + `integration.ts`
   parity guard).
3. Extend the async equivalence suite with the canonical single-tail-await
   body in all four syntactic shapes × host/WASI lanes.

## Acceptance criteria

- The canonical `const f = async (x) => await g(x)` activates CPS (host)
  and the drive machine (WASI); result observed as a real Promise / driven
  frame respectively.
- Full merge_group net-positive; no regression in the async-\* equivalence
  suite (legacy-model tests updated only where the shape now genuinely
  returns a Promise — same migration rule as #1796).
