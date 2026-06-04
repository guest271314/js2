---
id: 1820
title: "IR path: && || and ternary evaluate both operands (lost short-circuit + non-termination)"
status: ready
created: 2026-06-04
updated: 2026-06-04
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

