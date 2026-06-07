---
id: 1909
title: "standalone RegExp residual bucket after #1474/#682: split Phase 2d and native-engine gaps"
status: ready
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: regexp
goal: standalone-mode
related: [682, 1474, 1539]
test262_bucket: standalone-regexp
test262_count: 1997
---
# #1909 — Standalone RegExp residual bucket

## Problem

The standalone report still has `1,997` failures in `standalone-regexp` even
though the original native-RegExp umbrellas are marked done. Current samples
include unsupported flags and pattern forms such as `u`/`v`/`d`, lookahead,
negated shorthand inside character classes, and word-boundary variants.

## Scope

- Re-split the current RegExp bucket by signature and feature family.
- Land the smallest high-count native-engine slice if one is clearly ready
  (for example a contained flag/pattern form).
- Otherwise file child issues from the split and update the classifier so the
  dashboard stops pointing only at completed umbrellas.

## Acceptance Criteria

- `tests/issue-1909.test.ts` covers at least one newly-supported standalone
  RegExp residual or a classifier regression if this issue is analysis-only.
- The issue records the top current RegExp signatures and which child issue owns
  each.
- A rebuilt standalone report no longer treats the entire residual as only
  `#682/#1474`.

