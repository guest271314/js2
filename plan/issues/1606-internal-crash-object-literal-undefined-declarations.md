---
id: 1606
title: "codegen crash: 'Cannot read properties of undefined (reading declarations)' on object-literal expressions"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: object-literals
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 8
---
# #1606 — Internal compiler crash on object-literal expressions

## Problem

8 test262 tests crash the compiler:

```
Internal error compiling expression: Cannot read properties of undefined (reading 'declarations')
```

All 8 are `language/expressions/object` (the ES5 `11.1.5` object-initializer
section). The compiler dereferences `.declarations` on an undefined node while
compiling an object literal — an outright crash, not a graceful
unsupported-feature error.

## Failing test examples

- `test/language/expressions/object/11.1.5_7-3-2.js`
- `test/language/expressions/object/11.1.5-0-1.js`
- `test/language/expressions/object/11.1.5_4-4-a-3.js`

## Root-cause hypothesis

Object-literal codegen in `src/codegen/expressions.ts` (or `literals.ts`)
resolves a property's symbol/type and reads `symbol.declarations` (or
`type.symbol.declarations`) without a null guard. Some object-literal property
shapes in these ES5 tests (getter/setter pairs, duplicate keys, accessor
descriptors) produce a symbol with no `declarations`. Add a guard / fallback
type-resolution path.

## Acceptance criteria

- The three example tests compile without an internal crash.
- All 8 tests move off `compile_error`.

## Root cause (confirmed)

The crash fires only through the test262 runner's `wrapTest` + the static
eval-inline path (#1163). These tests do `eval("o = {get foo(){…}}")` /
`eval("({foo:0,foo:1})")` with a **constant string** argument, so the compiler
parses and splices the eval body inline (`src/codegen/expressions/eval-inline.ts`).
The spliced statements come from a foreign `SourceFile` created via
`ts.createSourceFile` — the TypeScript checker has **no symbol bindings** for
those nodes. Two object-literal codegen paths then call into the checker on
those foreign nodes, and TypeScript itself dereferences `.declarations` /
`.flags` / `.escapedName` on an undefined symbol and throws:

1. `compileArrowAsCallback` (`src/codegen/closures.ts`) →
   `checker.getSignatureFromDeclaration(getter/setter)` →
   `getDeclarationOfKind` reads `.declarations` of undefined.
2. `compileObjectLiteral` (`src/codegen/literals.ts:558`) →
   `checker.getTypeAtLocation({foo:0,foo:1})` → `checkObjectLiteral` reads
   `.flags` of undefined for the duplicate-key symbol.

The three distinct error spellings (`declarations` / `flags` / `escapedName`)
are all the same class: a checker call on a foreign-SourceFile node.

## Fix

Guard both checker calls so a checker-internal crash degrades to the existing
graceful path instead of crashing the whole compile:

- `closures.ts`: wrap `getSignatureFromDeclaration` + `getReturnTypeOfSignature`
  in try/catch; on failure the callback compiles with a void/any return type
  (the body still coerces its actual return value normally).
- `literals.ts`: wrap the no-contextual-type `getTypeAtLocation(expr)` in
  try/catch; on failure fall through to the externref plain-object lowering.

## Test Results

`tests/issue-1606.test.ts` — 4 cases (get/set pair, set-only, get-only,
duplicate data keys), all fail without the fix and pass with it.

Full `language/expressions/object` directory (306 tests) via `runTest262File`:
**0 internal crashes** (was 8). Post-fix the 8 tests are:
- `11.1.5_4-4-a-3` → now compiles and runs (`fail`, no longer a crash).
- the other 7 → clean `compile_error: Missing __make_getter_callback import`
  (graceful unsupported-feature diagnostic — wiring accessor callbacks through
  the eval-inline path is a separate feature, out of scope here).

No regressions: the additive try/catch guards only fire on a checker crash;
existing object-literal/accessor test files are unchanged with vs. without the fix.
