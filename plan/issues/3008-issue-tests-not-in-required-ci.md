---
id: 3008
title: "process gap: tests/issue-*.test.ts are not uniformly wired into required CI (silent regressions)"
status: ready
sprint: current
priority: low
assignee: ttraenkler/unassigned
created: 2026-07-03
feasibility: medium
reasoning_effort: low
task_type: chore
area: ci
language_feature: n/a
goal: quality-infra
related: [3007, 2767]
horizon: s
---

# #3008 — `tests/issue-*.test.ts` are not uniformly wired into required CI

## Finding (documentation only — do NOT fix the CI config in this issue)

While resolving #3007 (an `any`-context computed-index read emitting invalid
Wasm), we found that `tests/issue-2767.test.ts` had **6/11 tests failing on
`main`** with `Invalid Wasm binary` and it had **regressed silently** — no
required gate caught it.

Root cause of the blind spot: the required `quality` gate (`ci.yml`) and the
test262 conformance shards do **not** run the per-issue regression suites under
`tests/issue-*.test.ts` as a blocking check. A per-issue test can therefore go
red without failing any required check, so a codegen change elsewhere can break
a previously-fixed issue's guarantees and merge clean. #3007 is exactly that:
the underlying `__vec_get` funcIdx desync was latent, the Date/`toISOString`
test262 cluster (15/17 host) never exercised the specific `any`-return shape,
and `issue-2767.test.ts` — which did — was not gating.

A secondary, unrelated symptom found in the same sweep: at least one per-issue
file is outright broken at load time (`tests/array-externref-indexof.test.ts`
imports `./helpers.js`, which does not exist — it should be
`./equivalence/helpers.js`). A file-level import error like this silently
contributes **zero** assertions, so it too would never have flagged.

## Why it matters

The per-issue suites are the project's regression memory. If they are not a
blocking gate, that memory does not protect `main` — a fixed issue can quietly
re-break (as #2767 did).

## Suggested direction (for whoever picks this up — not prescribed here)

- Decide whether `tests/issue-*.test.ts` (or a curated subset) should be a
  required blocking check, and wire it into `quality` (or a dedicated job) if so.
  Watch RAM/time — the full vitest suite can OOM in constrained envs (see
  CLAUDE.md); a sharded or fast-subset run may be needed.
- Add a lint/CI guard that fails when a `tests/**/*.test.ts` file errors at
  collection time (import resolution), so a broken-import test can't pass by
  contributing zero assertions.
- Fix the concrete `array-externref-indexof.test.ts` import path as a trivial
  follow-up.

## Acceptance criteria

- A decision is recorded on whether/how per-issue suites gate CI, with the
  RAM/time tradeoff considered.
- (If adopted) the wiring lands and a deliberately-broken per-issue test fails
  CI.
