---
id: 1889
title: "any-value → f64 ToNumber over-rejects valid numeric strings (parseFloat fallback)"
status: backlog
created: 2026-06-05
updated: 2026-06-05
priority: low
feasibility: medium
task_type: bugfix
area: codegen
language_feature: type-coercion, tonumber
goal: correctness
sprint: Backlog
related: [1836]
---
# #1889 — `any`-value → f64 ToNumber is inconsistent / over-rejects valid strings

## Symptom

The `any`/externref → f64 coercion path (ToNumber on a statically-`any` value used
in arithmetic) is wrong for string operands:

- `const x: any = "12"; x - 0` → **NaN** (should be `12` — over-rejects a valid
  numeric string)
- `const x: any = "12"; x * 2` → **NaN** (should be `24`)
- inline `("12abc" as any) - 0` → **0** (should be `NaN`; different sub-path than the
  typed-variable case, so the two disagree)

The correct ToNumber(String) entry points (`Number(s)`, unary `+`, `*` on a
statically-typed string) already do strict StringToNumber and are correct — this is
specific to the `any`-value coercion fallback.

## Location

`src/codegen/type-coercion.ts` ~L1748 — the externref → f64 branch uses a
`parseFloat` (lenient) host fallback, then in some sub-paths drops to `f64.const NaN`
as a last resort, producing the inconsistent NaN/0/partial results above.

## Fix (sketch)

Route the `any`/externref → f64 numeric coercion through the same strict
StringToNumber funnel the typed paths use (spec ToNumber §7.1.4), rather than
`parseFloat`. Distinguish string vs. number vs. null/undefined operands at the
coercion site so a valid numeric string yields its value, a trailing-garbage string
yields NaN, and the inline-cast and typed-variable cases agree.

## Notes

Both-lane bug (not standalone-specific), off the standalone-57% critical path —
filed for tracking, not scheduled. Found while verifying the #1836 strict
StringToNumber residual (which is already fixed for the spec-relevant entry points).
