---
id: 1659
title: "CI does not run tests/equivalence/ (OOM) — genuine equivalence regressions land silently"
status: ready
sprint: Backlog
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: spec-completeness
related: [1658]
---
# #1659 — CI does not run tests/equivalence/ (OOM); equivalence regressions land silently

## Summary

The `quality` CI job currently runs only the **host-import budget** + **IR-alloc**
tests. The full **`tests/equivalence/`** suite is **NOT run in CI** because it
**OOMs in the runner**.

**Consequence:** real equivalence regressions are invisible to CI and can land on
`main` undetected. Two concrete examples surfaced during the dev-1553b
destructuring-lane sweep (2026-05-24):

1. **#1658** — a genuine codegen bug in the function-parameter default path
   (returns 30 where 40 is expected, on the real runtime). CI would not have
   caught it.
2. **Harness-fidelity gap** in `tests/equivalence/destructuring-initializer.test.ts`:
   the `__extern_get` stub in **`tests/equivalence/helpers.ts`** returns
   `undefined` for opaque WasmGC structs, so a destructuring **default wrongly
   fires** in the *test harness* even though the **real runtime is correct**.
   This is a harness bug, not a compiler bug — but it means the suite cannot run
   green as-is even once CI runs it.

## Acceptance criteria

Equivalence regressions get **gated (or at least reported)** in CI. Options to
explore (do **not** prescribe a single one up front — pick what fits the runner's
memory budget):

- **Shard** the equivalence suite like test262 (split across runners).
- Run it with **constrained workers** / `--no-threads` (single-fork, lower peak
  RAM) so it fits the runner.
- **Split** it into a separate **scheduled** CI job (e.g. nightly / on-merge)
  rather than the per-PR `quality` gate.

Whatever the chosen mechanism, the goal is: **a genuine equivalence regression
fails (or is reported on) a CI run**, rather than landing silently.

## Sub-item — harness fidelity fix

So the suite can run **cleanly** once enabled, fix the harness-fidelity gap in
`tests/equivalence/helpers.ts`: `__extern_get` returns `undefined` for opaque
WasmGC structs, which makes destructuring defaults wrongly fire in
`tests/equivalence/destructuring-initializer.test.ts`. The stub must faithfully
return the struct-backed value so the harness matches real-runtime behavior.

## Notes

- This is the gating dependency for **#1658**: #1658 is a real bug that is only
  currently catchable by running `tests/equivalence/` locally. Landing #1659
  makes that whole regression class CI-visible.
