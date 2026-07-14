---
id: 3266
title: "Split operator-assignment subsystem out of assignment.ts god-file"
status: ready
sprint: current
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/sendev-splitassign
---

# 3266 — Split operator-assignment subsystem out of assignment.ts god-file

## Scope

Behaviour-preserving god-file split (subtask of #3182). `src/codegen/expressions/assignment.ts`
is 7471 LOC. The contiguous back half (the `x op= y` lowering subsystem) is a cohesive,
zero-coupling leaf that moves verbatim into a NEW sibling module:

- **Destination**: `src/codegen/expressions/operator-assignment.ts`
- **Moved group (22 fns/consts)** — two adjacent cohesive families under one concern
  ("assignment with an operator"):
  - Logical assignment (`&&= ||= ??=`): `compileLogicalAssignment`,
    `compilePropertyLogicalAssignment`, `compilePropertyLogicalAssignmentExternref`,
    `compileElementLogicalAssignment`, `compileElementLogicalAssignmentExternref`,
    `isRefType`, `emitLogicalAssignmentPattern`.
  - Compound assignment (`+= -= *= &= >>=` + string / native-string `+=` fast paths):
    `isCompoundAssignment`, `compileAnyCompoundAdd`, `compileStringCompoundAssignment`,
    `tryCompileSingleCharBuilderAppend`, `compileNativeStringCompoundAssignment`,
    `compileAndCoerceToAnyStr`, `hasStringAssignment`, `hasStringAssignmentInParentScopes`,
    `compileCompoundAssignment`, `emitBitwiseCompoundOp`, `emitCompoundOp`,
    `compilePropertyCompoundAssignment`, `compilePropertyCompoundAssignmentExternref`,
    `emitToPropertyKeyOnce`, `compileElementCompoundAssignment`.

Coupling is zero: the moved functions reference no same-file top-level symbol, and the
remaining file (plain `=` assignment + destructuring) never calls any moved function. Only 4
public entry points are consumed externally (`compileLogicalAssignment`,
`compileCompoundAssignment`, `isCompoundAssignment`, `emitToPropertyKeyOnce`) by 3 files
(`binary-ops.ts`, `expressions.ts`, `unary-updates.ts`), which repoint their imports to the new
module.

## Acceptance

- `npx tsx scripts/prove-emit-identity.mjs check` prints **IDENTICAL** (39/39 emits).
- `npx tsc --noEmit` → 0 errors.
- All relocation-shift ratchets green (allowances below preauthorize the false-positive
  relocation shifts; byte-identity IDENTICAL proves total usage is conserved).

## Relocation-shift allowances

<!-- Filled in after running the ratchets locally; each is a documented per-issue preauth. -->
