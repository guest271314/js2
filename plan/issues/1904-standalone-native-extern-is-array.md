---
id: 1904
title: "standalone: native __extern_is_array predicate for Array.isArray over Wasm carriers"
status: in-review
pr: 1259
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: arrays, objects
goal: standalone-mode
parent: 1472
related: [1328, 1678, 1888]
test262_bucket: standalone-dynamic-object-property
test262_count: 8163
claimed_by: codex-developer
claimed_at: 2026-06-07T03:06:24.814Z
---
# #1904 — Native `__extern_is_array` for standalone

## Problem

The standalone dynamic object/property bucket still samples:

```text
Codegen error: '__extern_is_array' ... not yet supported in --target standalone
```

`Array.isArray` already has host-mode and compile-time paths, but any dynamic or
externref-shaped value falls through to `__extern_is_array`, which the broad
`__extern_*` standalone refusal catches. That blocks destructuring,
Array/TypedArray construction guards, and test262 harness checks that only need
a native brand predicate.

## Scope

- Add a standalone-native implementation for `__extern_is_array`.
- Route it through `OBJECT_RUNTIME_HELPER_NAMES` or an equivalent standalone
  native helper path before `STANDALONE_REFUSED_IMPORT`.
- Recognize the Wasm carriers that this compiler uses for arrays/rest vectors
  under standalone. Do not claim Proxy/exotic host arrays that cannot exist
  without a JS host.

## Acceptance Criteria

- `Array.isArray` over a standalone-emitted array/rest/vector carrier returns
  true where the JS semantics require an array result.
- Non-array `$Object` and primitive values return false without trapping.
- The regression test compiles and instantiates under `target: "standalone"`
  with no `env::__extern_is_array` import.
- JS-host/default behavior is unchanged.

## Implementation Notes

- Routed `__extern_is_array` through the standalone object-runtime native helper
  path before the broad `__extern_*` refusal.
- Reserved the helper with `ensureObjectRuntime`, then filled its body during
  finalize after all Wasm array carriers are known.
- The native predicate recognizes `$ObjVec`, `__vec_*`, and template vector
  carriers; primitives, `$Object`, and other externrefs return false.
- Proxy/host exotic recursion from ES §7.2.2 is intentionally out of scope for
  standalone because those carriers cannot exist without a JS host.

## Validation

- `npm test -- tests/issue-1904.test.ts`
- `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts`
- `npm run typecheck`

Final Codex verification on 2026-06-07: the scoped issue test, related regression set, and typecheck passed after refreshing the branch against current main. PR #1259's earlier test262 gate failure was on the stale published head and reported baseline drift; the branch was refreshed again against `origin/main` before republishing.

Codex rerun on 2026-06-07: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. The PR remains ready and non-draft with issue status `in-review`.

Codex final publish check on 2026-06-07: refreshed `origin/main`, confirmed it is already included in `symphony/1904` (`git merge --ff-only origin/main` was already up to date), reran the scoped issue test, related regression set, and typecheck successfully. PR #1259 is open, ready/non-draft, and targets `main`.

Codex final rerun on 2026-06-07: after fetching current `origin/main`, confirmed it is an ancestor of `symphony/1904`; `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. PR #1259 remains open, ready/non-draft, and targets `main`.

Codex post-merge rerun on 2026-06-07: merged the latest `origin/main` into `symphony/1904`, then reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully before republishing PR #1259.

Codex final check on 2026-06-07: merged current `origin/main` into `symphony/1904`, reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully. GitHub reports PR #1259 is already merged, so there is no remaining merge-queue action.

Codex verification on 2026-06-07: after fetching current `origin/main`, confirmed it is an ancestor of `symphony/1904`; `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is merged; no merge-queue or auto-merge action remains.

Codex dispatch check on 2026-06-07: revalidated the already-merged implementation from PR #1259 on `symphony/1904`; `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is merged, so no merge-queue or auto-merge action remains.

Codex stale redispatch check on 2026-06-07: fetched current `origin/main`, confirmed it is an ancestor of `symphony/1904`, reran the scoped issue test (4/4), related regression set (17/17), and typecheck successfully. GitHub reports PR #1259 is already merged and ready/non-draft history exists, so there is no remaining PR creation, merge-queue, or auto-merge action for this issue.

Codex redispatch verification on 2026-06-07: `git merge --ff-only origin/main` was already up to date, `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is merged; issue status is kept `in-review` per Symphony handoff rules, with no remaining merge-queue or auto-merge action.

Codex stale dispatch verification on 2026-06-07: fetched current `origin/main`, confirmed `origin/main` is already included in `symphony/1904`, and `git merge --ff-only origin/main` was already up to date. `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is already merged, so there is no remaining PR creation, merge-queue, or auto-merge action for this issue.

Codex stale dispatch closeout on 2026-06-07: verified PR #1259 is merged, ready/non-draft history exists, and `origin/main` is an ancestor of `symphony/1904`. Reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully. Issue status remains `in-review` per Symphony handoff rules; no merge-queue or auto-merge action remains after merge.

Codex redispatch closeout on 2026-06-07: merged current `origin/main` into `symphony/1904` and reran scoped validation on the refreshed branch. `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is already merged and was ready/non-draft, so no merge-queue or auto-merge action remains; issue status stays `in-review` for the poller.
