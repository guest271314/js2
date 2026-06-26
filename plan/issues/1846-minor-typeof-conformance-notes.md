---
id: 1846
title: "Minor typeof conformance: i64->'number' in with-bindings; externref->null fallthrough"
status: ready
created: 2026-06-04
updated: 2026-06-26
priority: low
feasibility: low
task_type: bugfix
area: codegen
goal: test262-conformance
sprint: 67
---
# #1846 — minor `typeof` conformance notes

## Defects
- `src/codegen/typeof-delete.ts:831` (`staticTypeofForWasmType`) maps i64 → "number"
  instead of "bigint" — reachable only via `with`-bindings, near-nil impact.
- `:684-690` the externref branch can `return null` for some non-undefined object
  operands (low confidence; verify against union operands).

## Spec
ECMAScript §13.5.3 typeof table.

## Fix
Add `if (kind==="i64") return "bigint"` before the f64 case; ensure the externref
branch returns "object" (or routes to runtime) for known non-undefined objects.

## Sprint 67 additions

The following test262 tests are tracked as closeable under this issue (baseline 2026-06-26):

- `test/language/expressions/typeof/symbol.js` — `typeof Object(Symbol())` must return `"object"` (boxed Symbol is an object); we currently return wrong value.
- `test/language/expressions/typeof/built-in-exotic-objects-no-call.js` — `typeof Math`, `typeof JSON`, `typeof Reflect`, etc. must return `"object"`; assert fails indicating wrong return.
- `test/language/expressions/typeof/syntax.js` — whitespace (`\t` tab character) before the typeof operand is valid; `eval("var\t...")` path fails, possibly due to whitespace normalization in our parser.
- `test/language/expressions/typeof/bigint.js` — `typeof 1n` must return `"bigint"` (wasm_compile error: "No dependency provided for extern class BigInt") — **NOTE: blocked on #2044 (BigInt i64-brand ValType architect decision). Do NOT include this test in the closeable count for Sprint 67.** Track separately under #2044/#1644.

Closeable count for Sprint 67: 3 tests (symbol, built-in-exotic-objects-no-call, syntax). `bigint.js` is explicitly deferred.

