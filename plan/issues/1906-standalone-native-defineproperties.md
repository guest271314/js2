---
id: 1906
title: "standalone: native Object.defineProperties over $Object descriptors"
status: in-progress
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: objects, property-descriptors
goal: standalone-mode
parent: 1472
related: [1472, 1629, 1631, 1888]
test262_bucket: object-property-semantics
test262_count: 748
claimed_by: codex-developer
claimed_at: 2026-06-07T07:30:34.943Z
pr: 1264
---
# #1906 — Standalone native `Object.defineProperties`

## Problem

The shared object/property semantics bucket still samples:

```text
Codegen error: '__defineProperties' ... not yet supported in --target standalone
```

Single-property descriptor paths have native standalone coverage for important
data/accessor slices, but the plural `Object.defineProperties` helper is still
caught by the broad dynamic object/property refusal.

## Scope

- Implement a standalone-native `__defineProperties` path for `$Object`.
- Iterate the descriptor map using the existing object-runtime enumeration
  helpers.
- Reuse native single-property helpers for data and accessor descriptors rather
  than introducing a second descriptor representation.
- Keep unsupported descriptor shapes fail-loud with this issue cited.

## Acceptance Criteria

- `Object.defineProperties(o, { a: { value: 1 }, b: { get() { ... } } })`
  compiles and runs under `target: "standalone"` for open `$Object` values.
- The helper performs gather/validate before apply where the current descriptor
  runtime supports it, or refuses before partial mutation for unsupported
  shapes.
- No `env::__defineProperties` import is emitted under standalone.
- Existing `Object.defineProperty` data/accessor tests remain green.

## Implementation Notes

- Added a standalone-native `__defineProperties` helper in the open-object
  runtime and routed it through `OBJECT_RUNTIME_HELPER_NAMES` so standalone does
  not refuse or import `env::__defineProperties`.
- The helper enumerates `$Object` descriptor maps with `__obj_ordered`, gathers
  and validates supported `$Object` descriptor records first, then applies them
  through the existing native `__defineProperty_value` and
  `__defineProperty_accessor` helpers.
- Focused tests in `tests/issue-1906.test.ts` use computed keys to force the
  `$Object` runtime path, covering data descriptors, accessor descriptors, and
  pre-apply refusal for unsupported primitive/conflicting descriptors.

## Validation

- `pnpm test tests/issue-1906.test.ts`
- `pnpm test tests/issue-1629-S6.test.ts tests/issue-1629-S3.test.ts tests/issue-1629-S2.test.ts`
- `pnpm exec tsc --noEmit --incremental false`

Revalidated by `codex-developer` on branch `symphony/1906` after fetching
current `origin/main` at `d6957d5dc`; checks above pass locally on
2026-06-07T09:34:28+02:00 at local head `a45dc1f8d` before this
issue-bookkeeping refresh. The focused #1906 suite, the existing #1629
defineProperty suites, and `tsc --noEmit` all passed in this worktree.

PR #1264 is open against `main`; the local issue status is back to
`in-progress` until the publish/CI blocker below is cleared.

## Publish Blocker

`codex-developer` revalidated locally and committed validation refreshes, but
the 2026-06-07T09:27+02:00 and 2026-06-07T09:37+02:00
`git push origin symphony/1906` attempts were rejected after local pre-push
typecheck/lint, prettier, and issue-integrity gates passed. GitHub rejected the
update with `GH006` because PR #1264 is already in the merge queue and queued
branches cannot be updated without dequeuing the PR first.

The queued remote head remains `0ea14d5a0`; the local branch has current-main
merge and issue bookkeeping commits beyond that queued head. This pass rechecked
the PR after fetching `origin/main` at `d6957d5dc` and rerunning scoped local
validation, and did not find a scoped implementation failure.

GitHub reports PR #1264 is already queued to merge. GraphQL reports merge queue
state `QUEUED`, position `7`, remote head `0ea14d5a0`, and ready non-draft PR URL
`https://github.com/loopdive/js2/pull/1264`. The PR check rollup is failing
because `Test262 Sharded / merge shard reports` hit the stale-baseline guard:
the `js2wasm-baselines` JSONL baseline main SHA
`ff02d201152dc8777d3e8151ed05dddd47d75ecf` is 114 commits behind
`origin/main`, exceeding the max 50 commit threshold. The standalone guard
itself reports `improvements=24`, `wasm-change regressions=0`, `net=24`. This
is an infrastructure blocker tracked by #1668, not a scoped #1906 local
validation failure. Because the publish step is blocked, this issue remains
`in-progress`.
