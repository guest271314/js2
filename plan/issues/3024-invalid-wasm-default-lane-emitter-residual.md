---
id: 3024
title: "codegen: invalid Wasm binary emission residual — default (JS-host) lane (~131 fails, externref/f64 type-mismatch emitter bugs)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: codegen-correctness
goal: correctness
test262_category: language/expressions/object/dstr, built-ins/AsyncFromSyncIteratorPrototype, language/expressions/in
test262_ce: 131
related: []
---

# #3024 — invalid Wasm binary emission residual (default lane)

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). **131**
official tests compile to a Wasm module that fails validation. Unlike the
several `standalone-invalid-wasm-*` issues already tracked (#2039, #2878,
#2934 — all standalone-target-specific), this bucket is on the **default
`gc` target**, so it's a distinct residual not covered by those.

## Breakdown by validator error

| reason | count |
|---|--:|
| `call[N]` expected `(ref null T)`, found other | 14 |
| `struct.new` — not enough args | 11 |
| `local.set` expected `(ref null T)` | 7 |
| `fN.ne`/`fN.trunc` expected `fN`, found `externref` | 13 (7+6) |
| `array.set` type error inside `__vec_from_extern` | (part of remainder) |
| other/remainder | ~76 |

Failing function names cluster around `test` (64 — top-level test body),
`testCompoundAssignment` (11), `__closure_*` (async-gen closures),
`__vec_from_extern_*`, `__obj_meth_tramp_*` (object-method trampolines).
Root cause is an externref-vs-f64/ref-null type mismatch at emit time in (a)
async-generator destructuring, (b) compound assignment operators, (c) the
"vec from extern" array-materialization helper.

## Sample failing files

- `language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-ary-elision.js`
- `built-ins/AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`
- `language/expressions/in/private-field-rhs-non-object.js`

## Suggested approach

1. Start with `testCompoundAssignment` (11 fails, single named function) —
   smallest, most concentrated sub-bucket; likely one type-coercion bug in
   compound-assignment codegen (`x += y` where `x`/`y` cross the
   externref/f64 boundary).
2. `__vec_from_extern_*` `array.set` type errors — check the element-type
   assumed by the array-materialization helper against the actual value
   representation of the source (likely a boxed-any vs. typed-element
   mismatch, similar in shape to the already-fixed #2379
   `new-array-n-boxed-any-elem-rep`).
3. Async-gen destructuring `__closure_*` failures — trace one repro through
   `-O0` unoptimized output (`--target gc` with binaryen disabled) to see
   the exact instruction sequence at the reported `call[N]`/`local.set` site.

## Acceptance criteria

- `wasm-validate`-class compile errors on the default `gc` target drop
  materially below the 131 recorded here.
- No regression in the standalone-lane invalid-Wasm counts (#2039/#2878/#2934)
  — this issue is scoped to the default target only.
