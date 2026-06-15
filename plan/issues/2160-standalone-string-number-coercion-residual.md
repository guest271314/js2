---
id: 2160
title: "Standalone String/Number method & coercion conformance residual (~635 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: string-number
goal: standalone-mode
parent: 1470
depends_on: [1917, 2104]
---

# Standalone String/Number method & coercion conformance residual

## Problem

Wasm-native string methods and standalone number formatting landed in #1470,
#1335, #1105 (all `done`, sprints 58–61). The host-vs-standalone baseline
diff (sha `31fa7e099`, 2026-06-15) shows **635 tests pass in host mode but
fail standalone**, attributed to String/Number method and coercion residuals.

## Evidence

- Gap categories: `built-ins/String` (643), `built-ins/Number` (159),
  plus String/Number coercion in `language/expressions`.
- Partly overlaps the coercion engine (#1917) and value-rep boxing
  (#2072/#2104) work — `__new_String`/`__new_Number` wrapper boxing leaks.

## Acceptance criteria

- Standalone pass count for `built-ins/String` + `built-ins/Number` rises
  toward host parity.
- No `__new_String`/`__new_Number` host-import leak for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1470. Sequenced after the coercion engine (#1917) and
value-rep P1 (#2104). Part of sprint-62 standalone catch-up (rank 4 by gap
impact).
