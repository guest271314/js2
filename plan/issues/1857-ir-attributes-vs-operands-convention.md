---
id: 1857
title: "Carry compile-time-constant facts as IR node attributes, not synthetic SSA operands"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: easy
reasoning_effort: low
task_type: refactor
area: ir
language_feature: compiler-internals
goal: maintainability
related: [1851]
---
# #1857 — Attribute vs operand split in the IR

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R11** (P3).

## Problem

A durable IR-design hygiene rule distinguishes two channels on a node:
**operands** (runtime SSA values, part of the use-def graph) and
**attributes** (compile-time-constant facts — a comparison predicate, an
alignment, a literal's payload, a backend/feature flag, a native-type
annotation). Keeping genuinely-constant facts in the *attribute* channel
keeps them attached and verifiable **without** polluting use-def reasoning,
SSA analyses, or coercion logic. We already carry such facts (native-type
annotations like `type i32 = number`, `nativeStrings`, string-backend
selection); the goal is to make "attribute, not operand" an explicit,
enforced convention as new IR nodes are added.

## Recommendation

When adding or revising IR nodes, carry compile-time-constant facts as
**node metadata/attributes**, never as synthetic SSA operands. (The closed
`IrType` union stays — it's the right call for a single-source-language
compiler; this issue is only about the operand-vs-attribute split.)

## Acceptance criteria

- [ ] Document the operand-vs-attribute rule in the IR contributor notes
      (`src/ir/` and/or `codegen-axes.md`).
- [ ] Audit existing IR nodes for compile-time facts smuggled in as operands;
      move any found into an attribute channel.
- [ ] New-node review checklist includes the operand-vs-attribute check.
