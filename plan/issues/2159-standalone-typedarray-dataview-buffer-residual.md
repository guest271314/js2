---
id: 2159
title: "Standalone TypedArray/DataView/ArrayBuffer conformance residual (~1,308 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 1461
---

# Standalone TypedArray/DataView/buffer conformance residual

## Problem

TypedArray callback methods, generic array-like receivers, and DataView/
ArrayBuffer support landed in #1358, #1461, #1654 (all `done`, sprints
51–58). The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15)
shows **1,308 tests pass in host mode but fail standalone**, attributed to
TypedArray/DataView/buffer semantics — the third-largest catch-up bucket
and currently **untracked/unscheduled**.

## Evidence

- Gap categories: `built-ins/TypedArray` (565), `built-ins/TypedArrayConstructors`
  (321), `built-ins/DataView` (336), `built-ins/ArrayBuffer` (78),
  `built-ins/Atomics` (132).
- Mostly `(none)`-leak `compile_error` (525 TypedArray + 287 ctor +
  135 DataView) — standalone codegen gaps, not host-import shims.

## Acceptance criteria

- Standalone pass count for the TypedArray/DataView/ArrayBuffer/Atomics
  categories rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1461. Part of sprint-62 standalone catch-up (rank 3 by gap
impact). Compile-error-heavy — likely shares root cause with the #2079
late-import index-shift class for some constructors.
