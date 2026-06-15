---
id: 2158
title: "Standalone class/prototype/private-name/descriptor conformance residual (~1,388 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: classes
goal: standalone-mode
parent: 1591
depends_on: [2101, 1965]
---

# Standalone class/prototype/descriptor conformance residual

## Problem

Class elements, private fields, brand checks, and descriptor fidelity landed
in #1591, #1365, #1364 (all `done`, sprints 51–61). The host-vs-standalone
baseline diff (sha `31fa7e099`, 2026-06-15) shows **1,388 tests pass in host
mode but fail standalone**, attributed to the class/prototype/private-name/
descriptor object model — the second-largest catch-up bucket.

## Evidence

- Concentrated in `built-ins/Object` (compile-error heavy) and class
  language tests; `dynamic_object_property` leaks plus `(none)`-leak compile
  errors in the object model.
- Implementation should consume the #2101 class object-model architecture
  spec and the #1965 base-constructor execution fix.

## Acceptance criteria

- Standalone pass count for `built-ins/Object` + class language tests rises
  toward host parity.
- Descriptor/private-name/brand-check semantics match host mode standalone.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1591. Implements against spec #2101; depends on #1965.
Part of sprint-62 standalone catch-up (rank 2 by gap impact).
