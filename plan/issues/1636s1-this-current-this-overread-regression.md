---
id: 1636s1
title: "regression: #1636-S1 __current_this over-read breaks direct-call `this` (171 test262 fails)"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: high
feasibility: hard
reasoning_effort: max
task_type: regression-fix
area: codegen
language_feature: this-binding
goal: spec-completeness
sprint: 50
parent: 1636
introduced_by: "PR #873 (#1636-S1 __call_fn_method_N dispatcher)"
---

## Problem

PR #873 (#1636-S1) added a `__current_this` module global so that closures
dispatched from the host via `__call_fn_method_N` (a value's `toJSON`, a
`JSON.stringify` replacer) observe the host-supplied receiver. The `ThisKeyword`
handler in `src/codegen/expressions.ts` gained a fallback that read this global
whenever `ctx.currentThisGlobalIdx >= 0`.

That gate was too wide. `ensureCurrentThisGlobal` is called **eagerly** in
`src/codegen/index.ts` (lines ~917 and ~3873) for any module that emits at
least one closure, so `ctx.currentThisGlobalIdx >= 0` was true module-wide.
The consequence: every `this` reference in a **directly-called named function**
(`function f(){ return this; }` → `call $f`) read the global's
`ref.null.extern` initial value (surfacing as `null`) instead of the
spec-correct `undefined` (strict mode) / globalObject (sloppy mode).

Net effect: 171 test262 regressions (-101 net), concentrated in
`language/function-code/10.4.3-1-*` (strict `this` binding) and
`built-ins/Array/prototype/*` (callback `this`).

## Root cause

The `__current_this` global is only meaningfully populated by the
`__call_fn_method_N` dispatcher, which `global.set`s the host receiver before
the inner `call_ref` and restores it after. Only closure bodies that can be
dispatched through that path (lifted free closures and anonymous callbacks)
should read it. Named function declarations, methods, and constructors are
compiled via `function-body.ts` / `class-bodies.ts` and invoked with `call $f`
— the dispatcher never runs for them, so the global is never installed on
their behalf and they must keep `undefined` / globalObject `this`.

## Fix (WHY, not just WHAT)

Added a `readsCurrentThis?: boolean` flag to `FunctionContext`
(`src/codegen/context/types.ts`) and set it `true` ONLY on the two
closure-body contexts that the host dispatcher can reach:

- `liftedFctx` in `src/codegen/closures.ts` (~line 1648) — lifted function
  expressions / arrows with captures, stored in a closure struct and invoked
  via `call_ref` (this is the body the `__call_fn_method_N` dispatcher calls).
- `cbFctx` in `src/codegen/closures.ts` (~line 2477) — anonymous callbacks
  (e.g. `JSON.stringify` replacer). Note: when `needsThis` is true, `this` is
  already bound to the explicit `__this` param at `localMap` index 1, so the
  fallback is never reached for getter/setter callbacks — the flag only
  matters for the no-explicit-`this` anonymous-callback shape.

The `ThisKeyword` fallback in `src/codegen/expressions.ts` now gates on
`fctx.readsCurrentThis && ctx.currentThisGlobalIdx >= 0`. Direct-call function
bodies have no flag → fall through to `emitUndefined` exactly as before #873.

### Why a flag and not a structural check

The distinction (lifted-closure body vs. direct-call body) is only known at
the FunctionContext-creation site in `closures.ts`. By the time
`ThisKeyword` is compiled there is no other reliable signal that the current
body is funcref-dispatchable — `currentThisGlobalIdx` is module-scoped, and
`localMap` absence of `this` is exactly the case we are disambiguating. A
per-context boolean set at the two lift sites is the minimal, local marker.

### Downstream-effect analysis

- Stack balance: the fallback either pushes one `global.get` (externref) or
  `emitUndefined` (also leaves one externref) — both branches are
  type-`externref` and single-value, so balance is unchanged regardless of
  which branch fires. No change to the dispatcher's save/restore sequence.
- Return types: unaffected — same `{ kind: "externref" }` result either way.
- Index shifting: no new imports/functions added; `addUnionImports` is not
  touched. The flag is a plain boolean on an existing struct.
- Static-class `this` (#1395) and local-`this` paths run earlier and are
  untouched; the flag only guards the final free fallback.

## Acceptance criteria

- Strict named function called directly: `function f(){ "use strict"; return this; }`
  → `f() === undefined` is `true`, even in a module that emits a closure.
- #1636-S1 host-dispatch path preserved: `issue-1636-s1-tojson-this.test.ts`
  still passes (6/6), including the "free-function closure resolves to
  __current_this" case.

## Test Results

- New: `tests/issue-1636s1-this-regression.test.ts` — 3/3 pass (strict named
  `this === undefined` in a closure-emitting module; strict named `this`
  resolves to undefined not null; strict global directive-prologue shape).
- `tests/issue-1636-s1-tojson-this.test.ts` — 6/6 pass (feature preserved).
- `tsc --noEmit` clean; `biome lint` clean on touched files.

### Out of scope (pre-existing, verified identical on clean origin/main)

- `illegal cast` runtime error when a lifted closure (`const cb = function(){}`)
  is invoked AND a boolean-returning function is called in the same module —
  reproduces on clean main with no `this` involved.
- `not enough arguments on the stack for call_ref` when passing a **named
  function declaration** (vs. an inline closure) as an Array.prototype
  callback — reproduces on clean main.
- Inline Array callback `this` binding to the element value — reproduces on
  clean main; orthogonal to the `__current_this` fallback.

Notes
- Checklist completed.
