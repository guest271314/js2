---
id: 3499
title: "Lower typed JavaScript bitwise composites through the Porffor backend"
status: in-progress
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: m
complexity: L
feasibility: hard
reasoning_effort: max
task_type: bug
area: ir, porffor, codegen-linear
language_feature: javascript-bitwise-operators
goal: backend-agnostic-ir
depends_on: [3497]
related: [1584, 1850, 2953, 3288, 3497, 3498]
assignee: ttraenkler/codex-senior-3499
origin: "2026-07-20 explicit user request to unblock exact landing-page fib.js through JS2 typed SSA and Porffor-C"
files:
  - src/ir/lower.ts
  - src/ir/backend/emitter.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/bytecode-emitter.ts
  - src/ir/backend/contract-conformance.ts
  - src/ir/backend/linear-emitter.ts
  - src/ir/backend/wasmgc-emitter.ts
  - src/ir/backend/porffor/sink.ts
  - tests/issue-3288.test.ts
  - tests/issue-3499-porffor-typed-bitwise-composites.test.ts
---

# #3499 — Porffor typed JavaScript bitwise composites

## Problem

The shared typed SSA represents JavaScript `&`, `|`, `^`, `<<`, `>>`, and
`>>>` as `js.bitand`, `js.bitor`, `js.bitxor`, `js.shl`, `js.shr_s`, and
`js.shr_u`. Their existing composite lowering correctly implements JavaScript
`ToInt32` and result conversion for WasmGC/linear, but it emits the constituent
instructions through `BackendEmitter.pushRaw`. Porffor deliberately rejects
the six operations in legality before that lowering because its symbolic sink
cannot accept raw Wasm.

After #3497 resolves the JSDoc signature of the exact landing `fib.js`, its
`(a + b) | 0` reaches this boundary and cannot proceed from shared IR to
Porffor IR and native C.

## Root cause

The operation is composite in the shared lowerer but only partly represented
by the backend contract. Ordinary arithmetic and unary operations already have
typed emitter methods. The scalar constants, numeric conversions, and final
native i32 bitwise step were still encoded as raw Wasm instructions. This made
the semantics reusable in source code but not in the backend contract.

Special-casing `fib`, rewriting its source, or introducing a Porffor-only IR
node would hide the missing contract operation and leave the other bitwise and
shift variants broken. Emitting direct C would also bypass Porffor's typed IR,
effect sequencing, and sanitizer-visible conversion helpers.

## Implementation plan

1. Add narrow typed scalar-constant, numeric-conversion, and i32-bitwise
   operations to the backend emitter contract.
2. Express the existing shared `ToInt32` composite entirely through those
   typed operations, preserving its exact WasmGC/linear instruction stream.
3. Map the operations to Porffor `Const`, `Convert`, and `Bin` nodes. Mask every
   shift count with `31`, perform left shift in the unsigned domain to avoid C
   signed-overflow UB, and preserve unsigned `>>>` result conversion.
4. Keep bytecode's legality boundary unchanged and fail loudly if the new
   contract methods are ever reached outside its admitted subset.
5. Cover every variant, both mixed f64/i32 directions, narrowed i32 chains,
   exact emitted Wasm/linear parity, no `RawC`, and native coercion edges under
   ASan/UBSan.
6. After #3497 lands on `origin/main`, merge that landed main and validate the
   exact checked-in website `fib.js` from source through shared IR and its
   `LinearMemoryPlan` into Porffor-C, comparing outputs with Node.

## Acceptance criteria

- [x] All six JavaScript bitwise/shift composites are legal for Porffor and
      lower through typed backend operations only.
- [x] Mixed f64/i32 operands and narrowed i32 chains preserve JavaScript
      coercion and signedness, including unsigned `>>>` results.
- [x] Shift counts are masked and native left shift avoids signed C overflow;
      focused generated C is clean under ASan/UBSan.
- [x] WasmGC and linear instruction streams remain identical and bytecode's
      unsupported-op boundary remains unchanged.
- [ ] The exact checked-in landing `fib.js` reaches JS2 linear IR/shared
      `LinearMemoryPlan`, Porffor IR, and native C after landed #3497 is merged;
      native outputs equal Node under ASan/UBSan.
- [ ] Focused tests, typecheck, lint, format, IR fallback, and linear-IR checks
      pass on the final landed-main merge.

## Implementation notes

The new emitter operations are intentionally smaller than an `Instr` and are
not a second IR. `lower.ts` remains the single owner of JavaScript coercion:
truncate, reduce modulo 2^32, saturating-convert to the i32 bit pattern, apply
the native operation, then convert signed or unsigned i32 back to f64 only when
the SSA result was not already narrowed.

Porffor maps `i32.trunc_sat_f64_u` through its range-aware conversion node with
the range-known flag clear. That detail matters for `NaN` and infinities:
Porffor uses its defined conversion helper rather than an undefined raw C
float-to-integer cast. `i32.shl` converts its left operand to u32 before `<<`
and converts the bit pattern back to i32 afterward. Every shift count is
explicitly converted to u32 and masked by `0x1f`; this makes the generated C
defined for counts such as 32 and 63 instead of relying on target behavior.

Current pre-prerequisite validation:

- `pnpm exec vitest run tests/issue-3288.test.ts tests/issue-3499-porffor-typed-bitwise-composites.test.ts`
  — 11 passed, 1 native test skipped without an explicit Porffor root.
- `JS2WASM_PORFFOR_ROOT=<pinned Porffor> PORFFOR_NATIVE_REQUIRED=1 pnpm exec vitest run tests/issue-3499-porffor-typed-bitwise-composites.test.ts`
  — 4/4 passed, including Clang `-fsanitize=address,undefined` over conversion
  edges, all operators, both mixed operand directions, and narrowed chains.
- `pnpm run typecheck` — passed.

#3497 is currently open as PR #3446 with green checks and has not been copied
or cherry-picked. Exact-source validation intentionally waits for that change
to land on `origin/main`, per the dependency boundary.
