---
id: 779e
title: "arguments-object mapped / trailing-comma / sloppy-strict residuals (~161 fails)"
status: done
created: 2026-05-21
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arguments-object
goal: property-model
sprint: Backlog
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
- [ ] No regressions in already-passing arguments-object tests.
- [ ] Both strict and sloppy variants pass for each touched test family.

## Resolution (2026-05-27)

Triage against current main found only ONE of the three listed sub-clusters
actually reproduces:

- **Trailing comma** (cluster 2): already passing — the TS parser drops a
  trailing comma, so `f(42, undefined,)` already gives `arguments.length === 2`.
- **Sloppy mapped** (cluster 1a): already passing — sloppy `arguments[i] = v`
  reflects into the named param (and vice-versa) via `fctx.mappedArgsInfo`.
- **`eval("arguments = 10")` SyntaxError** (cluster 3): eval-family, test262-
  skipped — out of scope.
- **Strict unmapped** (cluster 1b): THE BUG. The arguments object was built as
  *mapped* even in strict-mode functions, so writes to `arguments[i]` wrongly
  reflected into the named parameter (and back). §10.4.4 requires strict
  functions to get an *unmapped* arguments object.

### Fix

New helper `src/codegen/helpers/is-strict-function.ts` — detects strict-mode
functions via (a) a `"use strict"` directive prologue on the function or any
enclosing function / the SourceFile, or (b) class context (class bodies are
always strict). ES-module strictness is deliberately NOT inferred from
top-level import/export, because the compiler wraps every program in a
synthetic `export function test(...)` entry point — inferring module strictness
there would wrongly unmap *all* sloppy functions.

The mapped-arguments wiring now skips `fctx.mappedArgsInfo` for strict
functions, so the built `arguments` vec stays an independent copy:

- `src/codegen/function-body.ts` — top-level function declarations.
- `src/codegen/statements/nested-declarations.ts` — `emitArgumentsObject` gains
  an `unmapped` param; lifted function declarations pass `isStrictFunction`.
- `src/codegen/class-bodies.ts` — class methods always pass `unmapped = true`.
- `src/codegen/literals.ts` — object-literal methods pass `isStrictFunction`.
- `src/codegen/shared.ts` — delegate signature threads the `unmapped` flag.

### Tests

`tests/issue-779e.test.ts` — 6 cases (sloppy/strict × both sync directions,
trailing comma, class method). All pass. No new failures in the arguments
suites that use the standard import harness (issue-849, issue-1053). Pre-
existing failures in arguments-object.test.ts / issue-820b.test.ts are
unrelated harness issues (`{env:{}}` import object / missing `./helpers.js`),
not regressions from this change.
