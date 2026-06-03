---
id: 1782
title: "standalone numeric and BigInt separator literals evaluate to wrong values"
status: done
created: 2026-06-02
updated: 2026-06-03
completed: 2026-06-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: numeric-separators, bigint
goal: test262-conformance
sprint: Backlog
related: [53, 1781, 1644]
---
# #1782 - standalone numeric and BigInt separator literals evaluate to wrong values

## Problem

Numeric separator syntax is historically tracked by #53 and marked done, but
the refreshed standalone test262 artifact still has separator literal
assertion failures. These are not parser compile errors: the tests compile and
run, then return the wrong literal value.

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

Current count: **50** standalone failures under
`test/language/literals/*/numeric-separators/`:

- 30 numeric literal failures
- 20 BigInt literal failures

## Examples

```text
test/language/literals/numeric/numeric-separators/numeric-separator-literal-oil-od-nsl-od.js
returned 2 - assert.sameValue(0o0_1, 0o01)
```

```text
test/language/literals/numeric/numeric-separators/numeric-separator-literal-dd-dot-dd-ep-sign-plus-dd-nsl-dd.js
returned 2 - assert.sameValue(1.0e+1_0, 1.0e+10)
```

```text
test/language/literals/bigint/numeric-separators/numeric-separator-literal-hil-hds-nsl-hds.js
returned 2 - assert.sameValue(0x01_00n, 0x0100n)
```

```text
test/language/literals/bigint/numeric-separators/numeric-separator-literal-bil-bd-nsl-bd.js
returned 2 - assert.sameValue(0b0_1n, 0b01n)
```

## Likely root cause

Some standalone literal lowering path is still deriving the emitted value from
the literal text instead of the parser-resolved value, or it strips separators
after losing radix / exponent / BigInt suffix context. The failures cover
binary, octal, hexadecimal, decimal, exponent, and BigInt forms, so the fix
should audit all numeric-literal and BigInt-literal codegen paths rather than
patching one radix.

The important invariant from #53 still applies: if codegen uses
`NumericLiteral.text`, it must remove `_` before parsing while preserving the
radix prefix, exponent sign/digits, decimal point, and BigInt `n` suffix. If a
TypeScript-evaluated numeric value is available, prefer that value instead of
re-parsing the token text.

## Acceptance criteria

- All standalone failures under
  `test/language/literals/numeric/numeric-separators/` pass.
- All standalone failures under
  `test/language/literals/bigint/numeric-separators/` pass.
- Add focused regression coverage for binary, octal, hexadecimal, decimal,
  exponent, and BigInt separator literals.
- Default JS-host mode does not regress on numeric separator literals.

## Completion Summary (2026-06-03)

**Root cause was NOT literal value lowering.** TypeScript resolves
`NumericLiteral.text` to the already-decimal value (`0o0_1` → `.text === "1"`,
`0x01_00` → `.text === "256"`), so `Number(text.replace(/_/g, ""))` in
`src/codegen/expressions.ts` and the `BigInt(...)` path were always correct
for every radix, uppercase prefix, exponent, and BigInt suffix. WAT dumps
confirm correct constants: `0o0_1`→`1`, `0x01_00`→`256`, `1.0e+1_0`→`1e10`,
`0x01_00n`→`256n`, `0b0_1n`→`1n`.

**Actual defect:** the standalone `isSameValue` externref-equality path. The
50 baseline failures (`returned 2` = the *second* `assert.sameValue`, which is
the uppercase-prefix variant `0O…`/`0X…`/`0B…`) came from comparing two
separator literals that were boxed to externref through the `any`-typed
`assert.sameValue(actual, expected)` harness. The standalone externref `===`
comparison emitted invalid/mismatched Wasm there.

**Already fixed on current main** by #1776 (commit `1ff16008d` "standalone
isSameValue externref equality emits invalid Wasm" + `554b116e4` "refresh
externref equality late-import indices"). Verified by re-running the full
bucket through `wrapTest` + `compile(target: "standalone")` + `buildImports` +
instantiate: **52/52** value-checking tests now return `test() === 1`; the 57
remaining `*-err.js` entries are negative SyntaxError tests (expected
compile-errors), not value failures.

**This PR is docs + regression coverage only — no source change.** Added
`tests/issue-1782.test.ts` pinning the standalone separator-literal equality
(decimal/hex/octal/binary integers + lower/upper prefixes, decimal/exponent
floats, and all BigInt separator forms, each compared through an `any`-typed
`sv()` to exercise the externref path) plus a JS-host no-regression check on
uppercase-prefix value lowering.
