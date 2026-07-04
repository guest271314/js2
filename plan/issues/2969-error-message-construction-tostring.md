---
id: 2969
title: "Native Error construction: ToString(message) at construction (§20.5.1.1) + numeric payload rendering without number_toString pull-in"
status: done
assignee: ttraenkler/agent-error-msg
completed: 2026-07-02
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

## Resolution (2026-07-02)

Both residuals fixed.

1. **Construction-time ToString** — `emitErrorStructConstructor`
   (`src/codegen/registry/error-types.ts`) now routes the first ctor argument
   through the standalone `__any_to_string` chain before `struct.new`, guarding
   the undefined/null-argument case (`ref.is_null` → store null) so
   argument-less / `new Error(undefined)` / `new Error("")` errors still render
   the name alone. The helper emission (`emitNativeNumberFormat` +
   `ensureAnyToStringHelper`) runs BEFORE the ctor reserves its own `funcIdx`
   (#329/#1448 index-shift discipline). `number_toString` is forced first so the
   number arm is real. Gated on `standalone || nativeStrings`; host mode uses
   real JS Error objects (no struct ctor) and is byte-identical.

2. **Numeric payload rendering** — `emitExceptionRenderExports`
   (`src/codegen/native-strings.ts`) forces `number_toString` before it emits
   `__any_to_string`, so a throwing module that never itself stringifies a
   number still renders a raw thrown number ("42") instead of
   "[object Object]".

### Test Results

- `tests/issue-2969.test.ts` (10 tests, all pass): numeric/float/boolean/zero
  messages coerce; `new Error(42).message === "42"`;
  `String(new Error(42)) === "Error: 42"`; string messages idempotent;
  argument-less/undefined/empty render name-only; WASI target identical; host
  lane control unchanged; thrown `42`/`3.5` render `"42"`/`"3.5"` via
  `__exn_render_prepare` in a bare module.
- Existing error suites unchanged: `issue-2962` (14), `issue-2188` (7),
  `issue-2029` (3), plus error-reporting/catch-path suites — all pass (the 3
  `error-reporting.test.ts` `with`-statement location failures pre-date this
  change on `main`).
- Host lane byte-identical (sha256 of default-target binaries unchanged with vs
  without the change).

### Known residual (out of scope, not regressed)

- `new Error({ toString() { return "X" } })` renders `"Error: [object Object]"`
  rather than `"Error: X"`: `__any_to_string` does not run ToPrimitive/toString
  on a plain object (it returns the "[object Object]" literal). This is a net
  improvement over the prior `"Error"` (the message is now present); full
  object-message ToString needs the ToPrimitive machinery and is a separate
  concern from numeric coercion. Not in the acceptance criteria.
- `(e.message as any) === "42"` (message read forcibly re-typed to `any`) is
  still `false` — the `any === <string literal>` strict-equality path is a
  pre-existing limitation (it fails for string messages too, e.g.
  `(new Error("hi").message as any) === "hi"` on `main`). The naturally-typed
  read (`e.message` is `string` per the TS lib) compares correctly.

## PR #2534 CI-fix (2026-07-04): call-site ToString, not shared-ctor ToString

The first implementation routed the message ToString through the SHARED
`emitErrorStructConstructor` (`error-types.ts`). That ctor is also lazily
emitted for internal compiler error paths (destructuring / coercion
`TypeError`s), so pulling the `__any_to_string` family into those emissions
registered the `$AnyValue` type + any-equality helpers EARLY — which flips
standalone `any == any` / `any === any` from the correct native inline lowering
to the `__any_eq` / `__any_strict_eq` helper path. That helper's tag-5 field-4
arm deliberately does NOT value-compare boxed numbers (the numeric `f64.eq`
classifier was tried in #1888, ejected on the standalone floor at −162, and is
deferred to #2580 M2 / #3032 behind `tag5ValueEqClassifier`). Net: 6 broad
equivalence regressions (`any 5 === any 5` → false, etc.), and a pre-existing
latent class (`String(x)` + `any===any` already mis-compares on main).

**Fix:** revert `error-types.ts` to the lightweight raw-store ctor (main
behaviour — internal error emissions no longer pull any-helpers) and do the
null-guarded `ToString(message)` at the **user** `new Error(x)` call site
(`new-super.ts`, standalone/WASI branches only; host mode's import does JS
ToString). `number_toString` is forced there first so `__any_to_string`'s number
arm renders "42" not "[object Object]". The `native-strings.ts` numeric-exn hunk
is unrelated to the equality flip and stays. Verified: the 6 regressing snippets
return correct results, and `new Error(42).message === "42"` /
`new TypeError(99).message` work standalone.
