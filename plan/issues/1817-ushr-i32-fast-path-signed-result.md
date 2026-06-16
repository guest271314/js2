---
id: 1817
title: ">>> in i32 fast path produces a signed result (negative for high-bit values)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1817 — `>>>` i32 fast path produces a signed result

## Symptom
`(x >>> 0)` where `x` has the high bit set yields a *negative* float instead of
the correct large unsigned value (0..2^32-1).

## Location
`src/codegen/binary-ops.ts:1318`/`:1334`. `isI32PureExpr` accepts `>>>` as
i32-pure; the i32 result is later widened with `f64.convert_i32_s`
(type-coercion.ts:1330). The non-fast path (`compileBitwiseBinaryOp`, `:2548`)
correctly uses `f64.convert_i32_u`.

## Spec
ToUint32 — `>>>` result is unsigned.

## Fix
Exclude `GreaterThanGreaterThanGreaterThanToken` from the i32-pure fast path, or
emit `f64.convert_i32_u` when the consumer wants f64.

## Resolution
`>>>` is now excluded as the **result** op from both i32-result fast paths in
`src/codegen/binary-ops.ts`:
- `bitwiseI32` (the non-flatten i32-pure path) no longer fires for `>>>`.
- `tryFlattenBinaryChain`'s i32 branch routes `>>>` to `compileNumericBinaryOp`.

Both now fall through to `compileBitwiseBinaryOp`, which uses the unsigned
`f64.convert_i32_u`. `>>>` remains a valid i32-pure **leaf** (`isI32PureExpr`),
so nested chains like `(x >>> 3) & mask` keep the fast path — there the
intermediate i32 bit pattern feeds another bitwise op and is never
signed-widened to f64.

Note: this closes a **latent** gap. In current codegen every reachable `>>>`
already routed through `compileBitwiseBinaryOp` (verified by WAT dump:
`i32.shr_u` + `f64.convert_i32_u` in fast mode, native-i32, and chains), so
there is no observable behaviour change today — but the `compileI32BinaryOp`
`>>>` arm (bare `i32.shr_u` → signed widen) was a footgun that a future tweak
to the i32-pure predicate could have silently activated. The guards make that
impossible.

## Test Results
`tests/issue-1817.test.ts` — 8/8 pass (high-bit `-1 >>> 0` → 4294967295,
`-2147483648 >>> 0` → 2147483648, `-8 >>> 1`, positive values, fast-mode
single + chain, native-i32, nested `(x>>>4)&255`). No new failures in
`bitwise.test.ts` / `i32-fast-mode.test.ts` (15 pre-existing harness failures
confirmed identical on origin/main).

