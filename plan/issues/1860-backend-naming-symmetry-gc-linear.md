---
id: 1860
title: "Backend naming symmetry — rename codegen/ + codegen-linear/ to backend/gc + backend/linear (neither reads as the default)"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [1172, 1527, 1713]
---
# #1860 — Backend naming symmetry (`backend/gc` + `backend/linear`)

**Source:** [`docs/architecture/structure-and-language-assessment.md`](../../docs/architecture/structure-and-language-assessment.md) — follow-up 1.

## Problem

The two backends are documented as **alternatives, not rivals** — the choice
depends on the target (browser/WasmGC vs WASI/linear), and *both stay*
([`codegen-axes.md`](../../docs/architecture/codegen-axes.md), CLAUDE.md
"Architecture Principles"). But the directory naming contradicts that
principle:

- `src/codegen/` — the **unmarked default** (WasmGC lowering)
- `src/codegen-linear/` — the **suffixed, secondary-reading** one

The asymmetry quietly encodes "linear is the afterthought," which is exactly
the framing the architecture rejects. The tree should say what the doc says.

## Proposal

Rename to a symmetric pair under a shared parent so neither backend reads as
primary:

- `src/codegen/`         → `src/backend/gc/`
- `src/codegen-linear/`  → `src/backend/linear/`

### Open question for the implementer / architect

There is **already** a `src/ir/backend/` directory (the `BackendEmitter`
trait + `wasmgc-`/`linear-`/`bytecode-emitter`). A new top-level
`src/backend/` risks confusion with `src/ir/backend/`. Resolve before
executing — options:
- `src/backend/{gc,linear}/` (as requested) + a note distinguishing it from
  `src/ir/backend/` (the IR-level emitter trait), or
- `src/codegen/{gc,linear}/` (keeps the `codegen` root, avoids the clash).

Decide as part of this issue; the **symmetry** is the requirement, the exact
parent name is the detail.

## Cost / caveats

- **Wide import churn** — every importer of the two backend roots updates.
- **Doc/path updates** — `codegen-axes.md`, `compiler-design-lessons.md`,
  `structure-and-language-assessment.md`, CLAUDE.md "Project Structure", and
  any tooling/scripts that grep these paths.
- **Merge-conflict pressure** on a busy tree — best landed as a single
  mechanical commit during a quiet window, or **bundled with the #1172
  modularity audit** rather than as a standalone churn.
- Pure rename: **no behavior change.**

## Acceptance criteria

- [ ] Backend directories are symmetric (`gc` + `linear`), neither suffixed
      as secondary; the `src/ir/backend/` naming clash is resolved/noted.
- [ ] All imports, docs, CLAUDE.md paths, and path-sensitive tooling updated.
- [ ] No behavior change: equivalence + test262 green; diff is move+rename
      only.
