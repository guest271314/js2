---
id: 3044
title: "Object.defineProperty: compiler crashes on specific descriptor test shapes (invalid Wasm / illegal cast / op.endsWith / ctors-not-defined)"
status: ready
sprint: current
priority: high
horizon: s
feasibility: medium
created: 2026-07-05
task_type: bugfix
area: codegen
language_feature: object-defineproperty
es_edition: 5
goal: correctness
parent: 3022
related: [3022, 3024]
---

# #3044 — defineProperty descriptor-shape codegen crashes

Split from the #3022 umbrella. **Developer-scoped** — each is a concrete,
locally-reproducible compiler crash on a particular descriptor test shape (NOT a
descriptor-semantics gap). These are correctness bugs (the compiler emits an
invalid binary or throws internally) and can be picked off individually.

## Failing files + crash signature (16)

| file | crash |
|---|---|
| `15.2.3.6-4-255.js`, `15.2.3.6-4-256.js` | `invalid Wasm binary (WebAssembly.instantiate)` |
| `15.2.3.7-6-a-17.js`, `15.2.3.6-4-587.js` | `Codegen error: op.endsWith is not a function` |
| `15.2.3.7-6-a-113.js`, `15.2.3.6-4-117.js` | `illegal cast [in __closure_2()]` |
| `15.2.3.7-6-a-114.js` | `array element access out of bounds` |
| `typedarray-backed-by-resizable-buffer.js`, `coerced-P-grow/shrink.js` | `ctors is not defined` |
| `S15.2.3.6_A1.js` | `Cannot read properties of …` |

## Notes

- The `op.endsWith is not a function` signature is a codegen-internal bug
  (an `op` that is not a string reaches a `.endsWith` call) — likely shared
  across the two files; fixing it once should clear both.
- `illegal cast [in __closure_2()]` — a getter/setter descriptor compiled into a
  closure hits a bad cast; overlaps the accessor-in-closure path.
- `ctors is not defined` — resizable-ArrayBuffer-backed typed-array descriptor
  tests reference a harness global we don't provide (may be a harness/skip issue,
  verify before fixing).
- Several overlap #3024 (invalid-Wasm-emission residual) — cross-check before
  claiming so the fix lands in one place.

## Layer to fix

`src/codegen/*` — varies per crash; each has a minimal repro (the cited file).

## Acceptance

- The listed files compile to a valid binary (pass or a spec-correct runtime
  result), no compiler-internal throw. Scope: **DEV**, pick individual files.
