---
id: 53
title: "Issue 53: Numeric separators"
status: done
created: 2026-03-02
updated: 2026-06-02
completed: 2026-03-02
goal: compilable
sprint: 0
---
# Issue 53: Numeric separators

## Summary

Support numeric separators in literals: `1_000_000`, `0xFF_FF`, `0b1010_0001`.

## Current behavior

Numeric literals with underscores cause a compile error.

## Desired behavior

```ts
const million = 1_000_000;       // 1000000
const hex = 0xFF_FF;             // 65535
const binary = 0b1010_0001;     // 161
```

## Implementation

### Parser / Codegen
- TypeScript's parser already handles numeric separators and produces the correct
  numeric value in the AST node. The `NumericLiteral` node's `text` property contains
  the underscores, but its numeric value is already resolved.
- If we use `node.text` to parse the number, strip underscores first.
- If we use TypeScript's evaluated value directly, no change needed.
- Verify which path our codegen takes and fix accordingly.

## Complexity

XS — ~5 lines, 1 file (likely already works, just needs verification + test)

## Follow-up - standalone residual 2026-06-02

#53 remains the historical parser/codegen support issue, but the refreshed
standalone test262 artifact shows **50** remaining separator literal value
failures: 30 numeric literals and 20 BigInt literals. Those are tracked in
#1782 because they are assertion failures in standalone literal evaluation, not
the original compile-error support gap.
