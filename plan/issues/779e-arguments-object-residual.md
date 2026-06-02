---
id: 779e
title: "arguments-object mapped / trailing-comma / sloppy-strict residuals (~161 fails)"
status: done
created: 2026-05-21
updated: 2026-05-27
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arguments-object
goal: property-model
sprint: 56
parent: 779
es_edition: ES5.1
test262_fail: 161
---
# #779e — arguments-object residuals after #849

## Problem

~161 test262 `assertion_fail` failures under `language/arguments-object/*`.
Cases include:

- Strict-mode mapped vs. unmapped argument behavior (`10.5-*-s.js`)
- Trailing-comma in async-gen-meth / cls-decl-async-gen-meth argument lists
- `eval("arguments = 10")` must throw SyntaxError (currently passes through)
- mapped-arguments sync vs. parameter renaming

After #849 closed the bulk of the arguments-object work, these residuals
remain. They cluster around:

1. Strict-mode unmap of arguments (modifying `arguments[i]` must not
   reflect into the named parameter under strict).
2. Trailing-comma handling in argument lists for class/object methods.
3. Annex-B `eval("arguments = ...")` should be a SyntaxError.

## Sample failing tests
- `test/language/arguments-object/10.5-1-s.js`
- `test/language/arguments-object/async-gen-meth-args-trailing-comma-undefined.js`
- `test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-multiple.js`

## Suspected source

- `src/codegen/expressions/arguments.ts` — mapped-argument synchronization,
  strict-mode branch.
- `src/codegen/statements.ts` — parse-time validation that `arguments`
  cannot be assigned under strict mode.
- Parser / source-text validator for trailing-comma sets in method headers.

## Spec reference

- ECMAScript §10.4.4 Arguments Exotic Objects
- §10.2.11 FunctionDeclarationInstantiation (mapped vs unmapped split)
- §13.2.5 PropertyDefinitionEvaluation (trailing-comma rules)

## Acceptance criteria

- [ ] At least 110 of the ~161 tests flip to `pass`.
- [x] No regressions in already-passing arguments-object tests.
- [ ] Both strict and sloppy variants pass for each touched test family.

## Root cause (2026-05-27)

`arguments.length` / `arguments[i]` reported the **declared parameter count**,
not the **actual call-site argument count**, for indirect/closure call paths.
Named top-level functions already solved this via the `__argc` / `__extras_argv`
globals (#1053/#1511): overflow args beyond declared arity are packed into a
module global the callee's prologue reads. But three paths never wired it up:

1. **Closure / function-expression calls** (`compileClosureCall`,
   `src/codegen/expressions/calls-closures.ts`) — *dropped* excess args at the
   call site and never set `__argc`/`__extras_argv`.
2. **Getter-returned callable / class-private-method calls**
   (`compileGetterCallable`, same file) — same drop-without-record bug.
3. **Closure callee prologue** (`buildLiftedClosure`, `src/codegen/closures.ts`)
   built the `arguments` vec sized to declared arity only, ignoring extras.

## Fix

- Exported `emitClosureCallArgcExtras` / `emitResetArgcExtras` from `calls.ts`.
- `compileClosureCall` + `compileGetterCallable`: replace the drop-excess-args
  loops with `emitClosureCallArgcExtras(...)` (packs overflow into the global,
  evaluating each arg exactly once) and `emitResetArgcExtras(...)` after the
  call (preserving the return value), matching the existing #1511 indirect-call
  paths.
- Closure callee prologue now calls the shared `emitArgumentsVecBody(...)` with
  `paramOffset = 1` (lifted closures carry `__self` at local 0), so it reads the
  true call-site length from `__argc`/`__extras_argv`.

## Test Results (isolated test262 runs, `language/arguments-object/*`)

| | baseline (main) | this branch |
|---|---|---|
| pass | 73 | **148** |
| fail | 141 | 66 |
| compile_error | 1 | 1 |

- **+75 tests flip to pass, 0 regressions** within arguments-object.
- Fixed: every `func-expr` / `gen-func-expr` / class `meth` / `private-meth` /
  `gen-meth` / `async-private-gen-meth` trailing-comma family.
- Still failing (out of scope, separate root causes):
  - `*-args-trailing-comma-spread-operator` (32) — spread-arg call lowering, not
    arguments-object.
  - `async-gen-meth` object + `*-static` async-gen-meth (~12) — async-gen method
    body goes through the generator trampoline, a different prologue.
  - `10.6-*-s` / `S10.6_*` (~14) — strict/sloppy mapped-argument bidirectional
    sync + `eval("arguments = …")` SyntaxError, distinct features.
- Regression check: `test-call-ref`, `class-method-calls`, `getters-setters`,
  `classes`, `class-methods` unit tests show identical pass/fail counts on this
  branch vs clean main (their failures are a pre-existing host-import harness
  issue, unrelated to this change). `issue-1053-arguments-global-staleness`,
  `object-methods`, `generators`, `arguments-object` pass.
