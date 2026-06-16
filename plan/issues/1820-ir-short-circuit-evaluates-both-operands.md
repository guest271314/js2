---
id: 1820
title: "IR path: && || and ternary evaluate both operands (lost short-circuit + non-termination)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: ir
goal: correctness
sprint: 59
---
# #1820 — IR `&&`/`||`/ternary evaluate both operands

## Symptom
- `cond ? f() : g()` calls **both** `f()` and `g()`.
- `function fact(n){return n<=1 ? 1 : n*fact(n-1)}` recurses at the base case → non-termination.
- `p !== null && p.use()` runs the right side even when the guard is false.

## Location
`src/ir/from-ast.ts:3464` lowers ternary to `emitSelect` (Wasm `select`, eager);
`:3676` lowers `&&`/`||` to `i32.and`/`i32.or`. The selector (`src/ir/select.ts`)
admits `CallExpression` arms. `safeSelection` (codegen/index.ts:1225) only filters
on type-resolvability, not effect-safety.

Related Wasm-validity facet: a ref-typed ternary would emit untyped `select`
(0x1B), invalid for reference operands (needs typed `0x1C`) — `src/emit/binary.ts:704`.

## Fix
Only `select`/`i32.and`/`i32.or` when both arms are provably side-effect-free
(and numeric); otherwise lower to the short-circuiting `IrInstrIf` (exists) or
throw to fall back to legacy.

## Resolution
Lowered `&&` / `||` and the ternary through the short-circuiting `IrInstrIf`
unconditionally (rather than gating on a purity analysis), so the IR path is
correct for ALL arms — pure or effectful:

- `src/ir/from-ast.ts`
  - `lowerConditional` (ternary): replaced eager `lowerExpr(whenTrue)` +
    `lowerExpr(whenFalse)` + `emitSelect` with two `collectBodyInstrs(...)` arm
    buffers combined via `emitIfElse`. Only the taken arm runs. The false arm
    is hinted with the true arm's type (matching the `lowerNullish` carrier
    convention).
  - new `lowerLogicalAndOr`: intercepts `&&` / `||` at the top of `lowerBinary`
    (before the eager operand lowering, like `??`). The right operand is
    collected into its own body buffer and only runs on the branch that needs
    it: `a && b` → `if a then b else a`; `a || b` → `if a then a else b`. Kept
    the existing i32-operand scope (non-i32 throws clean fallback to legacy);
    removed the now-dead `&&`/`||` switch cases and the unused `requireI32`.

- `src/ir/lower.ts`
  - **Root-cause fix for the carrier mis-emit**: the local-allocation pass
    (`allocLocalForInstr`) recursed into `forof.*` / `try` / `while` / `for`
    body buffers but NOT into value-producing `if` then/else arm buffers. SSA
    values defined inside an arm and referenced cross-block (a nested-ternary
    sub-result, or a const arm carrier) therefore got no Wasm local, so
    `localIdx.get(...)` was undefined and the carrier emission mis-targeted an
    unrelated local → invalid Wasm (`local.set[0] expected type i32, found
    f64.const`). Added the `if` then/else recursion alongside the existing
    buffer kinds. This also hardens the existing `emitIfElse` consumers
    (`lowerNullish`, optional chaining) for non-trivial arms.

## Test Results
`tests/issue-1820.test.ts` — 6/6 pass. Reproduced on the unpatched baseline:
- `fact(n) = n<=1 ? 1 : n*fact(n-1)`: baseline → "Maximum call stack size
  exceeded" for every n (eager else-arm recursion); fixed → `fact(5)=120`,
  `fact(10)=3628800`.
- nested ternary `a>0 ? (a>10?100:10) : 0`: baseline (eager `select`) → `10`
  (correct); the first short-circuit attempt regressed it to invalid Wasm until
  the `lower.ts` `if`-arm local-allocation recursion was added — now `10`/`100`/`0`.
- `&&` / `||` over bool operands: all four truth-table combinations correct.

No regressions introduced:
- IR equivalence suites (`ir-ternary/-if-else/-let-const/-nullish/-numeric-bool`)
  show byte-for-byte the SAME pass/fail counts with and without this change. The
  failing entries are a pre-existing test-harness gap (the suites' `ENV` omits
  the `__box_number` import) reproduced identically on baseline — not caused by
  this fix.
- `pnpm run check:ir-fallbacks`: OK, no unintended bucket increase.
- `ir-nullish-coalesce.test.ts`: 4/4 pass (confirms the `lower.ts` change
  doesn't break existing `emitIfElse` consumers).

