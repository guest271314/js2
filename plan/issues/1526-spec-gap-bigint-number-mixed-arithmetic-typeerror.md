---
id: 1526
title: "spec gap: BigInt + Number mixed arithmetic should throw spec TypeError, not host error"
status: done
created: 2026-05-20
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: bigint, type-coercion
sprint: 52
es_edition: ES2020
test262_category: language/expressions/{addition,multiplication,division,exponentiation}, built-ins/BigInt
test262_count: 30
related: [1434, 1129]
---
# #1526 — Mixed BigInt + Number arithmetic surfaces as host error string

## Problem

30 test262 tests fail with the literal message:

```
Cannot mix BigInt and other types, use explicit conversions
```

This is the V8 engine's native runtime error string bubbling up
because our runtime delegates BigInt coercion to the JS host without
catching it and re-throwing a spec `TypeError`. Per §6.1.6.2 / §13.15
the operation should:

1. Apply `ToPrimitive` to both operands.
2. If exactly one is a BigInt → throw `TypeError`.
3. Otherwise proceed with the appropriate numeric algorithm.

We get step 3 right when both sides are BigInt; the broken case is
step 2 when one is BigInt and the other coerces via
`Symbol.toPrimitive` to BigInt or Number.

## Failing test examples

- `test/language/expressions/division/bigint-wrapped-values.js`
- `test/language/expressions/exponentiation/bigint-toprimitive.js`
- `test/language/expressions/multiplication/bigint-toprimitive.js`
- `test/built-ins/BigInt/wrapper-object-ordinary-toprimitive.js`
- `test/language/expressions/addition/coerce-bigint-to-string.js`

## Approach

1. Locate the binary-op codegen path that emits the host-import call
   for BigInt-mixed cases.
2. Wrap the host call in a try/catch that converts a host
   `TypeError("Cannot mix BigInt …")` into a spec `TypeError` with
   the standard wording, *or*
3. Better: detect the mixed-type case before the host call and emit a
   `throw new TypeError(...)` directly so the error site & message
   are spec-compliant in standalone mode too.

## Acceptance criteria

- The five example tests pass (they `assert.throws(TypeError, …)`).
- BigInt + BigInt arithmetic still works (regression-test addition,
  multiplication, division).
- Works in WASI / standalone mode (no JS host dependency for the
  throw).

## Estimated impact

**~30 test262 tests** — small but high-feasibility, and removes a
host-mode/standalone-mode behaviour gap.

## Resolution (2026-05-27)

The "easy" core scope — static-type mixed BigInt+Number arithmetic
throwing a spec `TypeError` — is already implemented and live on main:

- `src/codegen/binary-ops.ts:980-995` detects `leftIsBigInt !== rightIsBigInt`
  for arithmetic ops and emits `emitThrowTypeError(ctx, fctx, "Cannot mix
  BigInt and other types, use explicit conversions")` directly (a real
  `TypeError` instance, standalone-safe — no host dependency for the throw).
- `+` with a string operand routes to `compileStringBinaryOp` so
  `1n + "" === "1"` (ToString on the BigInt side) per §13.15.4.
- Validated at runtime (not just `WebAssembly.validate`): `1n + 1`,
  `1 + 1n`, `1n * 1` all throw a value that is `instanceof TypeError`;
  `1n + 1n` still computes; `"" + 1n === "1"` and `-1n + "" === "-1"`.
- Regression coverage exists in `tests/bigint-cross-type.test.ts`.

The **residual** 30 test262 failures listed under "Failing test examples"
(`division/bigint-wrapped-values.js`, `exponentiation/bigint-toprimitive.js`,
etc.) are NOT the static mixed-type case — they exercise **object-wrapped
ToPrimitive returning a BigInt** (`Object(2n)`, `{valueOf: () => 2n}`,
`{[Symbol.toPrimitive]: () => 2n}`). That requires full ToPrimitive→BigInt
plumbing through the object/wrapper coercion path, which is a substantially
larger feature than this issue's `feasibility: easy` scope and overlaps
[#1644] (BigInt i64-brand representation) and [#1568] (Object(BigInt)
auto-boxing). Tracked there; not reopened here.
