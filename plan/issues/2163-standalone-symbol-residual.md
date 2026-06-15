---
id: 2163
title: "Standalone Symbol conformance residual (~240 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: symbol
goal: standalone-mode
parent: 483
---

# Standalone Symbol conformance residual

## Problem

Symbol constructor / `typeof symbol` and `toNumeric` Symbol TypeError landed
in #483, #1564 (`done`). The host-vs-standalone baseline diff (sha
`31fa7e099`, 2026-06-15) shows **240 tests pass in host mode but fail
standalone**, attributed to Symbol semantics — currently **untracked**.

## Evidence

- `__symbol_register_desc` (368) and `__box_symbol` (325) host-import leaks
  in the gap; well-known symbols, registry (`Symbol.for`/`keyFor`), and
  argument validation.

## Acceptance criteria

- Standalone pass count for `built-ins/Symbol` rises toward host parity.
- No `__symbol_*` / `__box_symbol` host-import leak for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #483. Part of sprint-62 standalone catch-up (rank 9 by gap
impact).
