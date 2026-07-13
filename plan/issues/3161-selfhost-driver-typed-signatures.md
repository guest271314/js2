---
id: 3161
title: "Self-hosted stdlib driver: generalized typed-signature emit path (Precursor B/C — unblocks array-methods + object-runtime families)"
status: done
assignee: ttraenkler/fable-senior2
sprint: 71
created: 2026-07-12
updated: 2026-07-13
completed: 2026-07-12
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, codegen, stdlib
language_feature: compiler-internals
goal: ir-full-coverage
related: [3141, 3159, 3160]
origin: "plan/self-hosting-scale-up.md — Precursors B/C, dispatched as their own small issue per the plan"
---

# #3161 — Self-hosted stdlib driver: generalized typed-signature emit path

## Problem

The #3141 pilot driver (`src/codegen/stdlib-selfhost.ts`) hardcodes the pilot's
scope: every builtin and every callee is unary `(f64) -> f64`, and the IR is
process-memoized. The next two families in flight need more:

- **array-methods slice 1 (#3159, fable-selfhost)**: ctx-bound `ref_null`
  typeIdx params (raw data arrays), `i32`/`f64` mixed callees up to arity 6,
  void-returning kernels.
- **object-runtime slice 1 (#3160, fable-senior2)**: `externref` params/returns,
  void `__extern_set`, unannotated locals inferring externref from callee
  returns.

Both need typed per-builtin param/return signatures and typed per-callee
signatures — exactly Precursors B/C from `plan/self-hosting-scale-up.md`.
Landing the widening as its own PR FIRST decouples the two family slices
(both build on main, no cross-branch stacking).

## Design (agreed with fable-selfhost + tech lead, 2026-07-12)

New exports in `src/codegen/stdlib-selfhost.ts`, additive — the math pilot
path (`emitSelfHostedMathFunc` + its process memoization) keeps byte-identical
output:

```ts
export interface SelfHostedFuncDef {
  readonly name: string; // funcMap name == fn name in source
  readonly source: string; // ordinary TS, IR-claimable subset
  readonly paramTypes: readonly IrType[]; // positional, override-authoritative
  readonly returnType: IrType | null; // null == void
  readonly calleeTypes: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
}
export function buildSelfHostedIr(def: SelfHostedFuncDef): IrFunction;
export function emitSelfHostedFunc(ctx: CodegenContext, def: SelfHostedFuncDef): number;
```

Key decisions:

- **No process memoization on the generalized path.** `paramTypes`/callee
  types may carry ctx-bound `{ kind: "ref_null", typeIdx }` (typeIdx is only
  meaningful in the CodegenContext that registered it). Emission is
  funcMap-guarded once per compilation by `emitSelfHostedFunc`'s idempotent
  early-return — the same lifecycle the hand `Instr[]` bodies had — so the
  per-emit rebuild cost is negligible.
- **Param/return types flow via `paramTypeOverrides`/`returnTypeOverride`**
  (from-ast already supports both; non-primitive annotations like `unknown`
  defer to the override, primitive annotations must agree — enforced by
  `resolveIrType`).
- **Scope guard retained**: `resolveGlobal`/`resolveType` throw. `ref_null`
  ValType params do NOT hit `resolveType` (they are `val`-kind), so raw-array
  params pass through while accidental named-type/global dialect growth stays
  a loud compile error.
- **Math path deduped onto the generalized builder**: `buildBuiltinIr` becomes
  a memo-wrapping adapter constructing a `SelfHostedFuncDef` with `(f64)->f64`
  callee sigs and f64 param/return overrides — `resolveIrType` verifies the
  overrides agree with the `: number` annotations, output IR identical.

## Acceptance criteria

- [x] `emitSelfHostedFunc` + `SelfHostedFuncDef` + `buildSelfHostedIr` exported;
      math path output byte-identical (existing `tests/issue-3141.test.ts` +
      equivalence suite green).
- [x] Unit test covers the widened dialect shapes end-to-end
      (from-ast → verify → passes → lower with mock resolver): externref
      params/returns, void callees in statement position, i32-returning
      callees, `ref_null` typeIdx params, arity ≥ 3, unannotated locals
      inferring externref.
- [x] Compiler output unchanged for all programs (nothing calls the new
      export yet) — CI net 0.

## Evidence (2026-07-12)

- **Byte-identity of the math-path refactor**: `.tmp/probe-3161-byteident.mts`
  compiles a program exercising all nine self-hosted math builtins on both
  trees — host `e67749cf…` (2,217 B) and standalone `eebac3fc…` (38,192 B)
  SHA-256 identical between `main` and this branch.
- **Dialect finding (caller-side rule, documented in the driver header)**:
  a void builtin cannot END in a loop — `lowerTail` accepts return /
  expression / if / block / throw tails only, so void kernels need an
  explicit trailing `return;`.
- `tests/issue-3161.test.ts` (5 tests) green; `tests/issue-3141.test.ts`
  green; `tests/stdlib.test.ts` has 5 failures that reproduce identically
  on `main` (pre-existing, unrelated).

## Implementation notes (WHY)

- The two-stage split (`buildSelfHostedIr` / `emitSelfHostedFunc`) is kept
  from the pilot NOT for memoization (dropped here) but because the build
  stage is pure and unit-testable without a CodegenContext — the emit stage
  is thin proven glue (mint/push/funcMap, identical to the pilot's).
- `irTypeArgAssignable` (from-ast) requires EXACT IrType equality for scalar
  args — callers must declare index params as `f64` (intrinsics trunc
  internally) rather than relying on implicit f64→i32 coercion; this is a
  caller-side dialect rule, not a driver limitation (documented in the
  driver header).
