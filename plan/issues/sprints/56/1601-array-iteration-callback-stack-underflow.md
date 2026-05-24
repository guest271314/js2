---
id: 1601
sprint: 56
title: "codegen: Array.prototype reduce/reduceRight/map/filter callback paths emit invalid wasm (stack underflow at local.set/if/array.set)"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
task_type: bug
area: codegen
language_feature: array-iteration-methods
es_edition: multi
goal: compiler-correctness
test262_count: 156
related: [1522]
---

# #1601 — Array iteration methods emit stack-underflow wasm in callback path

## Problem

156 test262 tests fail with `invalid Wasm binary` where the Binaryen validator
reports a **stack underflow** inside the compiled `test` (or `__closure_N`)
function for an `Array.prototype` iteration method:

```
not enough arguments on the stack for local.set (need 1, got 0)
not enough arguments on the stack for if (need 1, got 0)
not enough arguments on the stack for array.set (need 3, got 2)
```

All 156 are `built-ins/Array` and concentrate on the callback-driven
iteration methods:

| method      | CE count |
|-------------|----------|
| reduce      | 62 |
| reduceRight | 57 |
| map         | 13 |
| filter      | 11 |
| findIndex   | 6 |
| find        | 6 |
| some        | 1 |

This is distinct from the generic type-boundary umbrella #1522 (which lists
only ~2 of each shape). The dominant cause here is the
**reduce/reduceRight accumulator path** and the **map/filter store path**
when the callback or species constructor is observed (e.g.
`create-species-undef`, getter-observing length, predicate-call tests).

## Failing test examples

- `test/built-ins/Array/prototype/reduce/15.4.4.21-8-b-iii-1-33.js`
- `test/built-ins/Array/prototype/reduceRight/15.4.4.22-9-b-16.js`
- `test/built-ins/Array/prototype/map/create-species-undef.js`
- `test/built-ins/Array/prototype/filter/create-species-undef.js`
- `test/built-ins/Array/prototype/findIndex/predicate-call-parameters.js`

## Root-cause hypothesis

The inlined/lowered iteration loop for these methods drops a value off the
operand stack on one control-flow edge:
- `local.set (need 1, got 0)` — the accumulator (reduce) or result temp is
  consumed without being produced on the early-exit / empty-array edge.
- `if (need 1, got 0)` — a predicate branch leaves the stack empty when the
  callback path is taken vs. the species/length-observing path.
- `array.set (need 3, got 2)` — the map/filter store emits index+array but
  not the value when the callback result coercion is skipped.

Likely site: the Array iteration intrinsic lowering in `src/codegen/`
(builtin Array method codegen, the reduce/map/filter loop emitters). Audit
the empty-array / species-undefined / abrupt-callback control-flow edges to
ensure every path either pushes the loop-body result or branches before the
consuming op.

## Acceptance criteria

- The five example tests above compile to a valid Wasm module (no
  `invalid Wasm binary` / stack-underflow).
- >=120 of the 156 tests in this cluster move off `compile_error`.
