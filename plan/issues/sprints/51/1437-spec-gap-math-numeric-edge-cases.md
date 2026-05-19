---
id: 1437
sprint: 51
title: "spec gap: Math numeric edge cases beyond random source"
status: ready
created: 2026-05-11
updated: 2026-05-11
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: math
goal: spec-completeness
related: [807, 1322]
---
# #1437 - Math numeric edge cases beyond random source

## Problem

Spec §21.3 is close but still partial: `309 / 327` passing. #1322 covers the
standalone `Math.random` source, but the report still shows assertion and
wasm_compile failures for numeric edge cases.

Known residual patterns include signed zero, infinities, `NaN`, and method
specific coercion details around `hypot`, `trunc`, `fround`, and newer Math
methods.

## Acceptance criteria

1. Add focused tests for signed-zero and infinity behavior in the failing Math
   methods.
2. Route Math arguments through the same ToNumber behavior as #1434 where the
   spec requires it.
3. Resolve the remaining §21.3 wasm_compile failures or document the exact
   unsupported proposal/runtime dependency.
4. §21.3 pass-rate rises above 98% after #1322 and this issue are both done.

## Files to inspect

- `src/codegen/builtins.ts`
- `src/codegen/math-ops.ts`
- `src/runtime.ts`
- `tests/issue-1437.test.ts`
