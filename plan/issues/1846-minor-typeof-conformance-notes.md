---
id: 1846
title: "Minor typeof conformance: i64->'number' in with-bindings; externref->null fallthrough"
status: backlog
created: 2026-06-04
updated: 2026-06-26
priority: low
feasibility: low
task_type: bugfix
area: codegen
goal: test262-conformance
sprint: Backlog
depends_on: []
---
# #1846 — minor `typeof` conformance notes

## DESCOPED → Backlog (2026-06-26)

Investigated the 3 Sprint-67 "closeable" tests against current main. None is a
clean win; each real sub-gap is split to its own tracked issue, and the original
one-liner defects yield ~0 test262 movement. Set `status: backlog`.

- **`built-in-exotic-objects-no-call.js`** — ALL `typeof new X()` asserts already
  pass ("object"); the only failure is assert #1 `typeof this` (top-level
  sloppy-script `this` must be the global object → "object"). Real semantics gap,
  **split to #2727** (feasibility: hard — needs script-mode-`this` / global-object
  design; do NOT attempt as a one-off).
- **`symbol.js`** — only `typeof Object(Symbol())` fails (returns "symbol"); needs
  a Symbol-wrapper-object boxing branch in the `Object()` call path. **Split to
  #2728** (feasibility: medium). Deliberately NOT done here: the `Object()`
  call-lowering is the busy/broad-coverage path that produced the #2149/#2702
  merge_group regressions — not worth the risk for a single test.
- **`syntax.js`** — routes through `eval(...)`; **eval-blocked** (see #1066
  standalone-eval). Consistent with the sprint's eval carve-out.
- **`bigint.js`** — blocked on #2044 (BigInt i64-brand ValType decision).
- **Original one-liner defects** (i64→"bigint" static map; externref→null
  fallthrough) — correct but near-nil impact (i64 path is `with`-bindings-only;
  bigint blocked on #2044). Not worth a standalone PR.

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

