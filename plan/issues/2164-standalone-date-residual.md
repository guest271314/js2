---
id: 2164
title: "Standalone Date conformance residual (~234 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: date
goal: standalone-mode
parent: 1343
---

# Standalone Date conformance residual

## Problem

Date prototype formatters landed in #1343 (`done`, sprint 50). The
host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows **234
tests pass in host mode but fail standalone**, attributed to Date semantics
— currently **untracked**.

## Evidence

- Gap category: `built-ins/Date` 235; `(none)`-leak compile errors (219)
  dominate — standalone codegen gaps in Date construction/formatting/coercion.

## Acceptance criteria

- Standalone pass count for `built-ins/Date` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1343. Part of sprint-62 standalone catch-up (rank 10 by gap
impact).
