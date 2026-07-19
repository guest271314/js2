---
id: 3280
title: "Decompose compileBinaryExpression — extract typed-operand dispatch + `in` operator into sibling modules"
status: done
sprint: 72
priority: high
feasibility: hard
model: opus
task_type: refactor
subtask_of: 3182
completed: 2026-07-14
assignee: ttraenkler/sendev-binops
area: codegen
---

# Decompose `compileBinaryExpression` (WAVE C)

## Scope

Behaviour-preserving **intra-function** decomposition of the ~3,129-LOC core
god-function `compileBinaryExpression` in `src/codegen/binary-ops.ts`. The
function dispatches a binary expression on operator and operand type. It is
lifted into cohesive sibling modules in two byte-identical slices:

- **Slice 1** (`binary-ops-typed-dispatch.ts`, `compileTypedBinaryDispatch`):
  the entire type-directed **tail dispatch** (original lines 1986–3420) — the
  region reached once both operands have been compiled to concrete Wasm value
  types (`leftType`/`rightType`, values already on the stack). Handles
  struct-ref valueOf coercion, strict/loose equality (ref identity,
  native-string content, `$AnyValue` tag-aware, the externref
  abstract-equality cascade), i32/i64/numeric arithmetic, and the f64
  coercion fallback. ~1,435 LOC lifted.
- **Slice 2** (`binary-ops-in.ts`, `compileInOperator`): the self-contained
  `key in obj` operator block (original lines 593–975) — private-brand runtime
  check, `in`-on-primitive TypeError, vec bounds check, static/dynamic key
  resolution, `__extern_has` host routing. ~383 LOC lifted.

Result: `compileBinaryExpression` drops from ~3,129 LOC to ~1,320 LOC (well
under the 1,500 god-function threshold), in the fewest clean cuts.

## Why these two cuts (senior-dev notes)

- **The tail is the biggest cohesive unit AND the safest lift.** It is the
  *terminal* dispatch: every path within returns, and there is no code after
  it in the function (the function ends at the fallback `return null`). So a
  contiguous lift needs **no fall-through sentinel** and **no write-back** of
  the reassigned `leftType`/`rightType` — the helper takes them by value, may
  reassign them locally (they flip to `{kind:"externref"}`/`{kind:"f64"}` on
  several arms), and always returns. `noParameterAssign` is off in biome, so
  the param reassignment is clean.
- **Free-variable signature was derived mechanically, not guessed.** The tail
  reads exactly these setup-locals computed earlier in the function:
  `leftType, rightType, leftTsType, rightTsType, wrapperEquality, isNumericOp,
  bothNativeI32, hasI32LocalOperand, isLooseEq, isLooseNeq, isEqOp, isNeqOp,
  arithI32WithToInt32Wrap, bitwiseI32` (the last four surfaced by `tsc` after
  the first pass — never inferred). Each is a `boolean`/`ValType`/`ts.Type`
  already in scope at the (new) call site, so the cut is a pure relocation.
- **Three module-local dispatch helpers were promoted to `export`**
  (`compileI32BinaryOp`, `compileI64BinaryOp`, `compileBooleanBinaryOp`;
  `compileNumericBinaryOp` was already exported). Adding `export` does not
  change emitted bytes. The resulting `binary-ops.ts ⇄ binary-ops-typed-dispatch.ts`
  import cycle is function-level only (no top-level use), which ES modules
  resolve fine.
- **The `in` block is independent of the tail** — it is gated on
  `op === InKeyword`, returns on every path, and reads only `ctx/fctx/expr`
  (no operand-ValType coupling), so Slice 2 stacks cleanly on Slice 1 with no
  region overlap.

## Safety gate — prove-emit-identity

Each slice was proven **byte-identical** with
`scripts/prove-emit-identity.mjs`: golden baseline written on clean
`origin/main`, `check` after the cut prints `IDENTICAL — all 39 (file,target)
emits match baseline` across the gc / standalone / wasi matrix. `tsc --noEmit`
stays at 0 and `biome lint` reports no unused imports. Both relocation-shift
gates are net-per-field (oracle #3070, coercion #3084), so intra-function
relocation is net-zero — no allowance needed. The new modules are each < 1,500
LOC (no `loc-budget-allow` required).

## Acceptance criteria

- `compileBinaryExpression` < 1,500 LOC.
- prove-emit-identity `check` IDENTICAL (39/39) after each slice.
- `tsc --noEmit` = 0; `biome lint` clean.
- Smoke test (`tests/issue-3280.test.ts`, #2093 gate) green — exercises the
  lifted equality / relational / numeric / string / bigint / `in` paths.

## Test Results

- Slice 1 (tail): prove-emit-identity IDENTICAL 39/39; tsc 0; biome 0.
  `binary-ops.ts` 4,582 → 3,164 LOC; new module 1,485 LOC;
  `compileBinaryExpression` ~3,129 → ~1,710 LOC.
- Slice 2 (`in` operator): prove-emit-identity IDENTICAL 39/39; tsc 0; biome 0;
  smoke test 11/11 green. `binary-ops.ts` 3,164 → 2,789 LOC; new module
  `binary-ops-in.ts` 417 LOC; `compileBinaryExpression` ~1,710 → ~1,330 LOC
  (< 1,500 threshold — goal met).
