---
id: 2162
title: "Standalone Map/Set/WeakMap/WeakSet conformance residual (~532 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: collections
goal: standalone-mode
parent: 1103
---

# Standalone Map/Set/Weak collections conformance residual

## Problem

Wasm-native Map/Set/WeakMap collections landed in #1103 (`done`, sprint 58).
The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows
**532 tests pass in host mode but fail standalone**, attributed to the
collection types — currently **untracked/unscheduled**.

## Evidence

- Gap categories: `built-ins/Set` 286, `built-ins/Map` 148,
  `built-ins/WeakMap` 101, plus WeakSet/WeakRef/FinalizationRegistry tails.
- `Set_new` and related host-import leaks plus `(none)`-leak compile errors.

## Acceptance criteria

- Standalone pass count for Map/Set/WeakMap/WeakSet rises toward host parity.
- No collection host-import leak (e.g. `Set_new`) for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1103. Part of sprint-62 standalone catch-up (rank 7 by gap
impact).
