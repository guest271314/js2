---
id: 1659
title: "CI does not run tests/equivalence/ (OOM) — genuine equivalence regressions land silently"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: spec-completeness
sprint: Backlog
required_by: [1658]
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

## Resolution (2026-05-27)

**Root cause of the OOM**: not the workload — it was vitest's default
`fileParallelism` spawning many forks at once. Running single-fork
(`--pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism`)
a 1/8 shard peaks ~1.06 GB RAM in ~62 s. The full suite across 8 sharded
runners is well within a 16 GB ubuntu runner.

**Mechanism chosen** (per acceptance criteria "gated or at least reported"):
- `.github/workflows/ci.yml` gains two jobs:
  - `equivalence-shard` — 8-way matrix, each runs `scripts/equivalence-gate.mjs`
    single-fork on its `--shard i/8`, uploads a partial failure list artifact.
  - `equivalence-gate` — downloads all partials, merges them, and gates against
    `scripts/equivalence-baseline.json` (committed known-failures list).
- The gate fails CI **only on NEW failures** (not present in the baseline) — a
  genuine regression. The existing failure backlog (tagged-template literals,
  for-await-of, generator-expressions, Object.isFrozen stubs, …) does not block
  every PR. Tests that the baseline lists but now PASS are reported as "newly
  fixed" so the baseline can be ratcheted down with
  `node scripts/equivalence-gate.mjs --update`. This mirrors the test262
  baseline-gate philosophy.

**Harness-fidelity sub-item (fixed)**: the naive `__extern_get` stub in
`tests/equivalence/helpers.ts` returned `undefined` for opaque WasmGC structs
because `obj[key]` cannot read struct fields by JS key, and direct
`buildImports` callers never call the runtime's `setExports` (so the
`__sget_<field>` struct-getter fallback was unavailable). Added
`instantiateWithRuntime(result)` to helpers — it overlays the runtime's real
host imports AND registers exports via `setExports`. `destructuring-initializer.test.ts`
now uses it; the previously-failing "nested destructuring with defaults" case
(expected 42, got 1) passes. The codegen was always correct — this was purely
a harness gap.
