---
id: 2161
title: "Standalone RegExp engine conformance residual (~579 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: regexp
goal: standalone-mode
parent: 1909
---

# Standalone RegExp engine conformance residual

## Problem

The standalone native RegExp engine landed in #682 and the #1909–#1914 phase
bucket (all `done`, sprint 61, mostly `critical`). The host-vs-standalone
baseline diff (sha `31fa7e099`, 2026-06-15) shows **579 tests still pass in
host mode but fail standalone**, attributed to the RegExp engine — currently
**untracked/unscheduled**.

## Evidence

- Gap category: `built-ins/RegExp` 554, of which 425 are `(none)`-leak
  `compile_error` and ~51 runtime `fail`.
- Residual phases the #1909–#1914 buckets did not fully close: source/flags
  reflection, `lastIndex` for global/sticky, `split`/`replace`/`matchAll`,
  and u/v/d-flag Unicode/lookaround edge cases.

## Acceptance criteria

- Standalone pass count for `built-ins/RegExp` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1909. Part of sprint-62 standalone catch-up (rank 5 by gap
impact).
