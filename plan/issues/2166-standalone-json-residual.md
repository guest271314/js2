---
id: 2166
title: "Standalone JSON conformance residual (~76 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: low
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: json
goal: standalone-mode
parent: 1599
---

# Standalone JSON conformance residual

## Problem

The standalone JSON parser/stringifier landed in #1599 (`done`, sprint 58).
The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows
**76 tests pass in host mode but fail standalone**, attributed to JSON
parse/stringify residuals — currently **untracked**.

## Evidence

- Gap category: `built-ins/JSON` 76; mix of runtime `fail` (reviver/replacer
  behavior, number formatting) and a few compile errors.

## Acceptance criteria

- Standalone pass count for `built-ins/JSON` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1599. Part of sprint-62 standalone catch-up (rank 12 by gap
impact). Likely benefits from the coercion engine (#1917) number/string path.
