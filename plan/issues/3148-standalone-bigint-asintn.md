---
id: 3148
title: "standalone: BigInt.asIntN / asUintN (20 __get_builtin CEs)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984, 1349, 1644]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
---

# #3148 — standalone BigInt.asIntN / asUintN

## Problem

`BigInt.asIntN(bits, bigint)` / `BigInt.asUintN(bits, bigint)` used standalone
hard-CE through the `__get_builtin` dynamic-shape refusal (#1472 Phase B).
Measured **20** non-pass standalone entries under
`built-ins/BigInt/{asIntN,asUintN}/`.

## Sample paths

- `test/built-ins/BigInt/asIntN/bigint-tobigint.js`
- `test/built-ins/BigInt/asIntN/bigint-tobigint-errors.js`
- `test/built-ins/BigInt/asUintN/bigint-tobigint-toprimitive.js`
- `test/built-ins/BigInt/asUintN/bits-toindex.js`

## Shared-infra deps

- **Blocked on / entangled with the BigInt i64-brand ValType decision**
  (#1349 / #1644 — see memory `project_bigint_i64_brand_gate`). `asIntN`/
  `asUintN` need a real BigInt value representation (i64-brand) to do the
  modular wrap; without it only the `ToIndex(bits)` / `ToBigInt` coercion
  ERROR-path tests (`*-errors.js`, `bits-toindex.js`, `*-toprimitive.js`) are
  reachable — those may flip with just the namespace recognizer + coercion
  throws, but the value-computation tests wait on the brand. Re-measure the
  error-path-only subset before sizing; may want to gate behind #1349.

## Acceptance

- The coercion/error-path subset compiles + passes standalone with 0
  regressions; value-computation tests tracked against the #1349 i64-brand
  landing.
