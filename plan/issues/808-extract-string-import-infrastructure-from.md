---
id: 808
title: "Extract string/import infrastructure from index.ts → imports.ts"
status: ready
created: 2026-03-26
updated: 2026-07-12
priority: high
feasibility: medium
reasoning_effort: high
goal: maintainability
sprint: current
subtask_of: 688
related: [3182]
---

> **2026-07-12 refresh (#3182 groom, elevated to current/high).** Partially
> landed since written: `addImport` now lives in
> `src/codegen/registry/imports.ts` (the natural extraction target — use it,
> not a new `imports.ts`), and several `collect*Imports` functions no longer
> exist under those names. Still in `src/codegen/index.ts` (15,693 LOC) as of
> today: `collectAllSourceImports` (:7680), `addStringImports` (:10093),
> `addUnionImports` (:10439), `addUnionImportsAsNativeFuncs` (:10758),
> `addIteratorImports` (:11701), `addArrayIteratorImports` (:11737),
> `addGeneratorImports` (:11779), `addForInImports` (:11819),
> `collectUsedExternImports` (:13825). The line numbers in the original body
> below are stale — re-anchor by symbol. Mind the `addUnionImports`
> index-shift invariant (CLAUDE.md "addUnionImports").
> (Also: original `goal: async-model` was a mis-tag; corrected to
> maintainability.)
# #808 — Extract string/import infrastructure from index.ts → imports.ts

## What moves

~3,500 lines — all import collection and registration:

- `collectStringMethodImports` (line 2556)
- `addStringImports` (line 2643)
- `collectPrimitiveMethodImports` (line 2390)
- `collectConsoleImports` (line 2208)
- `collectMathImports` (line 6714)
- `collectParseImports` (line 6775)
- `collectUnknownConstructorImports` (line 6887)
- `collectWrapperConstructors` (line 6934)
- `collectStringStaticImports` (line 6960)
- `collectPromiseImports` (line 7009)
- `collectJsonImports` (line 7128)
- `collectCallbackImports` (line 7181)
- `collectGeneratorImports` (line 7223)
- `collectFunctionalArrayImports` (line 7371)
- `collectUnionImports` (line 7461)
- `addUnionImports` (line 7540)
- `collectIteratorImports` (line 7753)
- `addIteratorImports` (line 7809)
- `addImport` (line 7856)
- `collectAllSourceImports` (line 2198)

## Validation

1. `npm test` must pass
2. Compile a file using Math, JSON, Promise, Array methods — verify same .wasm output
3. No behavior change

## Risk: LOW

These are all `collect*` functions called during the declaration collection pass. They read the AST and register imports. No circular dependency risk — they call `addImport` and `addFuncType` which can be exported from index.ts.

## Complexity: M
