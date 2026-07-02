---
id: 2969
title: "Native Error construction: ToString(message) at construction (§20.5.1.1) + numeric payload rendering without number_toString pull-in"
status: ready
sprint: Backlog
created: 2026-07-02
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: errors
goal: standalone-mode
related: [2962, 1104]
origin: "follow-up filed from #2962 (fable-2)"
---

# Native Error message residuals from #2962

## Problem

Two documented residuals from #2962's §20.5.3.4 stringification:

1. **Non-string constructor arguments**: `emitErrorStructConstructor`
   (src/codegen/registry/error-types.ts) stores the RAW first argument in
   `$Error_struct.$message`. Spec §20.5.1.1 requires
   `msg = ToString(message)` **at construction** when message is not
   undefined. So `new Error(42)` in standalone has `e.message === 42` (a
   number, spec says `"42"`), and `String(e)` renders `"Error"` instead of
   `"Error: 42"` (the #2962 `__error_to_string` treats a non-string message
   as absent rather than guessing).
2. **Thrown raw numbers render "[object Object]"** through the
   `__exn_render_prepare` export when the module never stringified a number
   (the `__any_to_string` number arm degrades when `number_toString` is not
   in `funcMap` — see `numberArm` in src/codegen/native-strings.ts).

## Approach

- At the ctor: coerce the message argument through the `__any_to_string`
  chain (or a lighter string-or-number coercion) before `struct.new`. Watch
  the emission-order/funcIdx discipline — the ctor is emitted from many
  call sites (`emitThrowJsError`, class-bodies super-forwarders); the
  coercion helper must be ensured BEFORE the ctor body bakes.
- For (2): have `emitExceptionRenderExports` force
  `emitNativeNumberFormat`/`number_toString` availability (size cost only
  for throwing modules), or accept the residual.

## Acceptance criteria

- `new Error(42).message === "42"` and `String(new Error(42)) === "Error: 42"`
  in standalone; host lane unchanged.
- Thrown `42` renders `"42"` via `__exn_render_prepare` regardless of other
  module content.
