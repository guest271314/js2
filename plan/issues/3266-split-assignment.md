---
id: 3266
title: "Split operator-assignment subsystem out of assignment.ts god-file"
status: done
completed: 2026-07-14
sprint: 72
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/sendev-splitassign
# Relocation-shift allowances (#3131 change-scoped gates read these from the PR's own issue file).
# Byte-identity IDENTICAL (prove-emit-identity 39/39) proves total usage is conserved — these are
# false-positive relocation shifts (counts moved out of assignment.ts into the new sibling module).
loc-budget-allow:
  - src/codegen/expressions/operator-assignment.ts
coercion-sites-allow:
  - src/codegen/expressions/operator-assignment.ts
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

Coupling is near-zero and one-directional: the moved functions reference exactly ONE
staying-behind symbol — `compileExternSetFallback` (already exported by assignment.ts) — so the
new module imports it back from `./assignment.js`; there is NO forward edge (the remaining file —
plain `=` assignment + destructuring — never calls any moved function). This keeps a clean
one-way edge (operator-assignment.ts → assignment.ts) with no import cycle. Only 4 public entry
points are consumed externally (`compileLogicalAssignment`, `compileCompoundAssignment`,
`isCompoundAssignment`, `emitToPropertyKeyOnce`) by 3 files (`binary-ops.ts`, `expressions.ts`,
`unary-updates.ts`), which repoint their imports to the new module.

## Acceptance

- `npx tsx scripts/prove-emit-identity.mjs check` prints **IDENTICAL** (39/39 emits).
- `npx tsc --noEmit` → 0 errors.
- All relocation-shift ratchets green (allowances below preauthorize the false-positive
  relocation shifts; byte-identity IDENTICAL proves total usage is conserved).

## Relocation-shift allowances (applied)

All ratchets run locally; byte-identity IDENTICAL (39/39) is the proof these are false-positive
relocation shifts (total usage conserved, counts merely moved module home):

- **LOC budget** (`check:loc-budget`) — new module is 2922 LOC (> 1500). Granted via the
  `loc-budget-allow:` frontmatter above. (assignment.ts drops 7504 → 4642.)
- **Oracle ratchet** (`check:oracle-ratchet`) — 15 `getTypeAtLocation` + 19 `ctx.checker`
  RELOCATED sites. Granted via two `preauthorized` entries in
  `scripts/oracle-ratchet-baseline.json` (the only mechanism this gate reads; mirrors the #808
  precedent). assignment.ts's counts drop by the same amount: getTypeAtLocation 21 → 6,
  ctx.checker 32 → 13 (perfectly conserved).
- **Coercion sites** (`check:coercion-sites`) — 12 RELOCATED coercion-vocabulary sites
  (`number_toString` ×4, `emitBoolToString` ×3, `__unbox_number` ×5). Granted via the
  `coercion-sites-allow:` frontmatter above.
- **Dead exports** (`check:dead-exports`) and **verdict-oracle bump** — pass unchanged (pure move).
