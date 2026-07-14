---
id: 3271
title: "refactor(codegen): break up generators-native.ts god-file + DRY cleanup"
status: ready
sprint: current
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/senior-dev-3271
---

# refactor(codegen): break up `generators-native.ts` god-file + DRY cleanup

## Problem

`src/codegen/generators-native.ts` is a ~4927-LOC god-file mixing three
concerns: the native-generator **planner/register/emit core** (the
state-machine builder), the **AST-scan predicate primitives**, and the
**consumer / call-site subsystem** (how the rest of codegen invokes
`.next()/.return()/.throw()`, reads the `{value,done}` result struct, and
consumes a generator in for-of / spread / toVec).

## Scope

Behaviour-preserving breakdown, emitted-Wasm byte-for-byte identical.

**Extractions (verbatim moves into sibling modules):**
- `generators-native-consumer.ts` — the consumer / call-site subsystem
  (`tryCompileNativeGeneratorMethodCall`, `tryCompileNativeGeneratorResultProperty`,
  `tryCompileNativeGeneratorForOf`, `emitNativeGeneratorToVec`, result-struct
  reads, dispatch builder, and their private helpers). Clean unidirectional cut:
  0 back-edges into the planner/state-machine core.
- `generators-native-ast-scan.ts` — pure AST-scan predicate primitives
  (`statementContainsYield`, `nodeContainsYield`, `bodyReferencesOwnName`,
  `bodyHasNewTryRegionAcrossYield`, …). No `ctx`, no planner/emit calls.

**DRY dedups (only provably byte-identical merges):**
- `loadCastState(anyLocal, stateTypeIdx)` — the repeated `local.get` +
  `ref.cast` to the state struct in `buildNativeGeneratorDispatch`.
- `isFunctionLikeScope(node)` — the 4-way function-like disjunction used to
  prune nested scopes during AST scans (EXCLUDES the intentional 3-way
  variants that omit arrow functions).
- `readResultField(local, resultTypeIdx, fieldIdx)` — the repeated
  `local.get` + `struct.get` result-struct field read.

## Acceptance

- `npx tsx scripts/prove-emit-identity.mjs check` prints **IDENTICAL**
  (39/39 file,target across gc/standalone/wasi).
- `tsc --noEmit` stays at 0 errors.
- Relocation-shift ratchets green (per-issue frontmatter allowances only,
  never whole-tree baseline edits).
- Smoke test `tests/issue-3271.test.ts` compiles generator-consumer programs.

## Implementation Notes

(Filled in as work lands — records WHY each cut is byte-safe and which dedups,
if any, were backed out for byte-identity.)
