---
id: 1765
title: "nullable number alias guard not narrowed for typed-array byte assignment"
status: done
created: 2026-06-01
updated: 2026-06-01
completed: 2026-06-01
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: type-system
language_feature: type-narrowing
goal: platform
sprint: 58
es_edition: n/a
related: [389, 1753, 1755]
origin: "GitHub #389 guest271314 comment 2026-06-01T00:17:59Z"
---
# #1765 — nullable number alias guard not narrowed for byte assignment

## Problem

In the June 1, 2026 GitHub #389 update, guest271314 reported that the
Node-style 64 MiB chunking code had to avoid a natural nullable sentinel shape:

```ts
let append = null;
// ...
const hasAppend = append !== null;
// ...
if (hasAppend) {
  output[cursor] = append;
}
```

The compiler rejected the assignment because `append` still had the
`null | number` shape at the `Uint8Array` element write. The workaround was to
use a numeric sentinel (`-1`) instead of `number | null`.

That is too brittle for normal TypeScript/JavaScript control-flow. The compiler
should either preserve TypeScript's narrowing for the guarded assignment or
lower this common nullable-number pattern safely when the guarded branch proves
the value is numeric.

Source: <https://github.com/loopdive/js2/issues/389#issuecomment-4588674539>

## Minimal repro shape

```ts
export function writeMaybeAppend(flag: boolean): number {
  const output = new Uint8Array(8);
  let append: number | null = null;
  if (flag) append = 93;

  const hasAppend = append !== null;
  if (hasAppend) {
    output[0] = append;
  }

  return output[0];
}
```

Also cover the direct guard:

```ts
if (append !== null) {
  output[0] = append;
}
```

## Scope

- Reproduce the failure in the smallest TS source and, if applicable, the
  equivalent allowJs/JSDoc shape.
- Preserve or reconstitute the narrowed numeric type for `Uint8Array` element
  assignment inside a direct null guard and an aliased boolean guard.
- Keep the fix narrow: this does not require a general tagged-union
  representation for arbitrary `number | object` unions.

## Acceptance

- The minimal nullable-number sentinel examples compile and instantiate.
- `output[cursor] = append` writes the numeric byte when the guard succeeds.
- The #389 chunking helper can use `number | null` sentinels without changing
  to `-1`.
- Regression tests cover both direct and aliased null guards.

## Implementation notes

- Root cause: `number | null` locals were lowered as plain `f64`, so the null
  sentinel was erased at initialization. Direct guards could compile but had
  incorrect false-branch behavior (`append !== null` effectively became true).
- Fix: explicit nullable-number local declarations now use an `externref` slot
  so `null` and boxed numbers are preserved. Reads unbox through
  `__unbox_number` when TypeScript or the compiler's null-guard tracking proves
  the identifier is non-null.
- Aliased guard support is intentionally narrow: `const hasAppend =
append !== null` is recorded as a per-function null-guard alias and applied
  to `if (hasAppend)` / `if (!hasAppend)` branches.
- The alias case also hit TS2322 before codegen. The compiler now downgrades
  that diagnostic only for guarded `Uint8Array[index] = nullableNumber`
  assignments where the surrounding direct or aliased null guard proves the
  RHS non-null.
- Added `tests/issue-1765.test.ts` covering direct and aliased guards, with a
  prefilled byte to verify the false branch does not write `0`.
