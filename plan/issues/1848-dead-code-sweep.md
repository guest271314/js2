---
id: 1848
title: "Dead-code sweep: identical branches, unused locals/params, obsolete scaffolding"
status: backlog
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: low
task_type: chore
area: codegen
goal: maintainability
sprint: Backlog
---
# #1848 — dead-code sweep

Verified dead code / no-op branches found in the 2026-06-04 review:

- `src/codegen/type-coercion.ts:1065` — `from.kind==="ref_null" ? {anyref} : {anyref}` (both arms identical). **Verified.**
- `src/emit/binary.ts:440-444` — `if (...) {...} else {...}` both call the same `encodeTypeDef`. **Verified.**
- `src/codegen/stack-balance.ts:687` — `const fixups = 0` never reassigned; final `return fixups` always 0.
- `src/ir/from-ast.ts:793` — `const writes = new Set()` created then discarded.
- `src/codegen-linear/c-abi.ts:262-263` — `body.splice(body.length,0)` no-op + unused `callIdx`; `:177` dead `exportReplacements`/`mangleCabiName`; `src/link/linker.ts:225` `externalImports` placeholder; `:417` unused `funcCounter`.
- `src/codegen/expressions/unary-updates.ts:718` — `const isIncrement = false` constant-folds dead ternary arms.
- `src/compiler/validation.ts:448` — `const opStart` assigned, never read.
- `src/codegen/binary-ops.ts:2552` — `compileModulo` ignores both params.
- `src/codegen/type-coercion.ts:73,988` — deprecated `CompileStringLiteralFn` param of `coerceType` unused.
- `src/codegen/statements/loops.ts:2398` — obsolete `__str_charAt` name-rescan (premise false since #1677).
- `src/codegen/string-ops.ts:1994` — unreachable default-separator `else` in native `split`.

## Fix
Remove each; for the identical-branch cases collapse to the single statement.

