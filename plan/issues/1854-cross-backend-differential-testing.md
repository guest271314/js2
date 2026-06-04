---
id: 1854
title: "Cross-backend differential testing harness — same TS to WasmGC / linear / bytecode-VM must produce identical observable output"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: test-infrastructure
related: [1714, 1715, 1851, 1852]
---
# #1854 — Cross-backend differential testing harness

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R7a** (P1).

## Problem

The `tests/equivalence/` suite compiles-and-runs against a JS/TS reference
oracle (the right backbone). But we now have **three** lowering paths behind
the `BackendEmitter` trait (WasmGC, linear memory, bytecode-VM), and nothing
asserts they agree with **each other**. A backend-specific lowering bug
(e.g. a linear-memory layout error, or a divergent boxing choice from #1852)
that produces wrong-but-not-crashing output can pass the single-oracle test
on whichever backend the test happens to run.

## Recommendation

Add a **cross-backend differential test**: compile the same TS program to
each available backend and assert **identical observable output**. This is
nearly free given the dual/triple backend and catches the exact class of
backend-divergence bugs the reference oracle alone can miss. It also becomes
the regression guard for the per-backend value representation (#1852) and the
trait-migration work (#1851).

## Acceptance criteria

- [ ] A test helper compiles a TS source to WasmGC **and** linear (and, where
      applicable, the bytecode-VM) and diffs observable results (return value,
      stdout, thrown errors).
- [ ] Seeded from a representative corpus (numeric kernels, strings, objects,
      arrays, control flow, closures) — start with the existing equivalence
      corpus.
- [ ] A divergence fails the test with a minimal-enough repro pointer
      (full minimization is #1855).
- [ ] Wired into CI; runtime kept modest (subset corpus if needed).
