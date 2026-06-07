---
id: 1910
title: "standalone ToPrimitive residual bucket after #1900/#1525b"
status: ready
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, type-coercion
language_feature: to-primitive, abstract-operations
goal: standalone-mode
related: [1806, 1900, 1525, 1525b, 1759]
test262_bucket: object-to-primitive
test262_count: 1237
---
# #1910 — Standalone ToPrimitive residual bucket

## Problem

The current standalone report still assigns `1,237` failures to
`object-to-primitive`, but the historical owners are mostly done or in-review:

- `#1806` / `#1900` covered standalone native ToPrimitive slices.
- `#1525` is done.
- `#1525b` is in review for method trampoline / step-6 residuals.
- `#1759` is done and was WASI number-string specific.

This bucket needs a current split so remaining failures are no longer hidden
behind completed umbrella records.

## Scope

- Rebuild or inspect the latest standalone JSONL for top ToPrimitive signatures.
- Separate real native ToPrimitive gaps from template/string/RegExp/Date
  coercion and classifier over-matches.
- Fix one contained residual if obvious; otherwise file child issues and update
  the classifier.

## Acceptance Criteria

- The issue records current top files/signatures for the `object-to-primitive`
  bucket.
- A focused regression test is added for any fixed residual.
- The report classifier points the remaining bucket at current follow-up issues
  instead of only completed historical owners.

