---
id: 3148
title: "standalone: BigInt.asIntN / asUintN (20 __get_builtin CEs)"
status: done
completed: 2026-07-14
assignee: ttraenkler/senior-dev-3148
sprint: 72
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984, 1349, 1644]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
# (#3102) The native BigInt.asIntN/asUintN handler is added inline in the
# property-access-call dispatch of calls.ts, consistent with its sibling
# standalone-native builtin handlers already inline in the SAME block
# (Number.is*, RegExp.escape, String.fromCharCode). calls.ts sits exactly at
# its LOC cap, so this genuinely-intended feature growth needs an allowance;
# the baseline re-absorbs it post-merge (#3131).
loc-budget-allow:
  - src/codegen/expressions/calls.ts
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

## Resolution (2026-07-14)

Added a standalone/WASI-native `BigInt.asIntN` / `BigInt.asUintN` handler in the
property-access-call section of `src/codegen/expressions/calls.ts`, right after
the `Math.*` handler. The `#1349`/`#1644` i64-brand BigInt rep
(`{kind:"i64", bigint:true}`) has **already landed**, so — contrary to the
issue's original "may want to gate behind #1349" caveat — the full modular wrap
is now expressible as pure i64 ops with **no JS host import**. The arm is gated
on `ctx.standalone === true || ctx.wasi === true`; host (gc) mode keeps the
existing `__get_builtin` path (real JS BigInt) and is byte-unchanged.

### Why this design (not a symptom patch)

- **Root cause**: `BigInt.*` member calls fell through to the generic
  member-call path → `env::__get_builtin`, which refuses-loud under standalone
  (#1472 Phase B). The fix intercepts *before* that fallthrough with a native
  lowering, mirroring the sibling `Number.is*` / `String.fromCharCode` /
  `RegExp.escape` standalone-native handlers in the same block.
- **Spec order (order-of-steps.js)**: `ToIndex(bits)` is evaluated *before*
  `ToBigInt(value)`. The handler compiles `bits` (and its coercion side
  effects) first, stores it in a local, then compiles `value` — preserving the
  observable valueOf ordering.
- **ToIndex(bits)** = ToNumber → `f64.trunc` (truncate toward zero, per
  ToIntegerOrInfinity) → RangeError when `< 0` or `> 2^53-1` (a real
  `RangeError` *instance* via `buildThrowJsErrorInstrs`, so wrapped
  `assert.throws(RangeError, …)` sees `e instanceof RangeError`). `NaN` fails
  both range comparisons (no throw) and is mapped to `0` by the signed
  `trunc_sat` (spec: `ToIntegerOrInfinity(NaN) = 0`).
- **ToBigInt(value)** rides the existing expected-type coercion
  (`{kind:"i64", bigint:true}` → `__to_bigint`), which already throws TypeError
  on undefined/null/symbol. A missing value arg is a direct TypeError throw.
- **Modular wrap** in i64, keyed on the bits value at runtime (works for a
  literal *or* a computed `bits`):
  - `bits == 0` ⇒ `0n`.
  - `1 ≤ bits ≤ 63`: asIntN sign-extends via `(v << (64-bits)) >>_s (64-bits)`;
    asUintN masks via `v & ((1<<bits)-1)`.
  - `bits ≥ 64` ⇒ value unchanged. This is exact for asIntN and for asUintN of
    a non-negative value. Special-casing `0` and `≥64` is **required** because
    Wasm shift counts are taken mod 64, so a raw `64-bits` shift at the boundary
    would alias to a 0-shift and mis-handle it.

### Representability boundary (the honest limit)

The i64-brand rep holds only the **low 64 bits** of a BigInt, which is exactly
what `asIntN`/`asUintN` of `bits ≤ 64` observes — so those are computed
correctly *even for source literals wider than 64 bits* (verified:
`asIntN(8, 0xabcdef0123456789abcdef0123n) === 0x23n`). Two subsets remain
out of scope (inherently unrepresentable in i64, still tracked against the
#1349 lane, not regressed by this change — they were CE before and are non-pass
now):

1. `asIntN`/`asUintN` with `bits > 64` where the true result needs bits the i64
   rep does not carry (e.g. `asIntN(65, huge)`, `asIntN(200/201, huge)` in
   `arithmetic.js`).
2. `bigint-tobigint.js` **string/array→BigInt** value coercion — `__to_bigint`
   /`__bigint_ctor` do not yet parse a string to a BigInt in standalone (a
   pre-existing infra gap: `BigInt("10")` itself throws a `WebAssembly.Exception`
   in standalone today, independent of this handler). The number/boolean value
   cases and all `bits-toindex.js` numeric coercions **do** pass.

## Test Results

- `tests/issue-3148.test.ts` — 33 cases, all green: asIntN/asUintN across bit
  widths (0, 1, 2, 4, 8, 64, >64), negative inputs, wide (>64-bit) literals,
  ToIndex numeric coercions (trunc-toward-zero, NaN⇒0), a no-`__get_builtin`-CE
  guard + `env`-import-leak guard, and a host-mode-still-compiles guard.
- `tsc --noEmit` clean; existing `tests/bigint*.test.ts` + `tests/issue-1644*`
  all pass (no regression).
