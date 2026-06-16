---
id: 1859
title: "Per-src-subdir module-contract READMEs (checker, ir, codegen, codegen-linear, emit, link, runtime, compiler)"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: easy
reasoning_effort: low
task_type: docs
area: docs
language_feature: compiler-internals
goal: contributor-readiness
related: [1172, 1860, 1527]
---
# #1859 — Per-subdir module-contract READMEs

**Source:** [`docs/architecture/structure-and-language-assessment.md`](../../docs/architecture/structure-and-language-assessment.md) — follow-up 2.

## Problem

The `src/` layout is a clean pipeline (`checker → ir → codegen +
codegen-linear → emit → link → runtime`, plus `compiler/`), but the
boundaries between several subdirs are **not self-evident to a newcomer** —
e.g. what is the difference in responsibility between `compiler/`, `codegen/`,
and `emit/`? The conceptual model lives in
[`codegen-axes.md`](../../docs/architecture/codegen-axes.md) /
[`compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md),
but a reader landing in a subdir has no local signpost. This is friction
against the `contributor-readiness` goal.

## Proposal

Add a short **module-contract header per `src/` subdir** — either a
`src/<dir>/README.md` or a top-of-`index.ts` doc block — stating, in a few
lines each:

1. **Responsibility** — what this module owns (one sentence).
2. **Inputs / outputs** — what it consumes and produces (e.g. "AST → IR",
   "IR → WasmGC `Instr[]`", "`Instr[]` → binary bytes").
3. **May depend on / must NOT depend on** — the allowed dependency direction,
   so layering violations are obvious in review (e.g. `ir/` must not import
   from a concrete backend; backends depend on `ir/`, not vice versa).
4. **Link** to the relevant architecture doc section.

Subdirs to cover: `checker/`, `ir/`, `codegen/`, `codegen-linear/`, `emit/`,
`link/`, `runtime/`, `compiler/` (rename-aware if #1860 lands first).

## Acceptance criteria

- [ ] Each `src/` subdir has a concise module-contract README / header
      (responsibility, in/out, dependency direction, doc link).
- [ ] The stated dependency directions match reality (spot-check imports; no
      claimed-forbidden edge actually exists).
- [ ] Linked from `codegen-axes.md` as the per-module index.
