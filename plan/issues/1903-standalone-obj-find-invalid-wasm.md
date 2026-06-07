---
id: 1903
title: "standalone object runtime: __obj_find emits invalid Wasm in dynamic-property bucket"
status: in-review
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: objects, property-access
goal: standalone-mode
parent: 1472
related: [1472, 1888]
test262_bucket: standalone-dynamic-object-property
test262_count: 8163
pr: 1262
claimed_by: codex-developer
claimed_at: 2026-06-07T02:08:54.150Z
---

# #1903 — Standalone object runtime: `__obj_find` invalid Wasm

## Problem

The current standalone report still classifies `8,163` failures under
`standalone-dynamic-object-property`. One sample signature is a validator error
inside the native object runtime:

```text
invalid Wasm binary ... "__obj_find" failed: i32.and expected type i32, found call of type externref
```

This is not a missing feature. It is a bad Wasm emission inside the runtime that
should be fixed before larger object-model work, because it can mask real
remaining semantic failures.

## Scope

- Inspect `src/codegen/object-runtime.ts`, especially `__obj_find` and flag/key
  checks around tombstones/accessor/data entries.
- Find the path where an externref-producing helper is left on the stack for an
  `i32.and`.
- Preserve the existing `$Object`/`$PropMap` representation and dual-mode
  invariant: standalone native path only, JS-host mode unchanged.

## Acceptance Criteria

- Add a focused regression test in `tests/issue-1903.test.ts` that previously
  forces the invalid `__obj_find` shape.
- The test compiles with `target: "standalone"`, validates with
  `WebAssembly.validate`, and instantiates with an empty import object.
- The generated module has no `env::__extern_*`, `env::__object_*`, or
  `env::__new_plain_object` imports.
- No broad refactor of the object runtime.

## Implementation Notes

- Root cause: `ensureObjectRuntime` could register object helper bodies after
  native-string helpers had snapshotted an older import base. A later uniform
  native-string finalize reconciliation could then over-shift the freshly
  registered object-runtime call indices, so `__obj_find`'s hash call could land
  on an externref-producing helper before `i32.and`.
- Moved `reconcileNativeStrFinalizeShift` to `src/codegen/native-strings.ts`
  and re-exported it from `expressions/late-imports.ts` for existing callers.
- `ensureObjectRuntime` now reconciles native-string import drift immediately
  after `ensureNativeStringHelpers(ctx)` and before registering `$Object`
  helpers, matching the existing union-helper base-settling invariant.
- Added `tests/issue-1903.test.ts`, a standalone dynamic computed-property
  lookup with native strings that validates, instantiates with `{}`, and asserts
  no `env::__extern_*`, `env::__object_*`, or `env::__new_plain_object` imports.
- Publish follow-up: the first ready PR run reached a stale standalone baseline
  guard after `#1905` landed on `main`. Merged `origin/main` into this branch
  before republishing so `#1262` is evaluated against the current main payload.
- Publish follow-up 2: re-merged current `origin/main` (`3fc48711b`, #1910)
  into this branch, kept the #1903 object-destructuring classifier addition,
  and left generated standalone report artifacts aligned with current main.
- Publish follow-up 3: re-merged the later `origin/main` baseline refresh
  (`5bef49a5`) and kept the generated standalone report artifact on main's
  refreshed payload.
- Publish follow-up 4: merged current `origin/main` (`3827daa96`, #1263) into
  this branch after GitHub reported PR #1262 as conflicting; the only conflict
  was unrelated #1907 issue metadata, resolved to main's in-review PR record.
- Final handoff (2026-06-07): refreshed the local checkout against
  `origin/main` (`3827daa96`), confirmed PR #1262 is open and non-draft, and
  found no additional #1903 source changes needed.

## Validation

- `npx vitest run tests/issue-1903.test.ts` (before and after merging
  `origin/main`)
- `npx vitest run tests/issue-1472.test.ts -t "dynamic property add/read"`
  (before and after merging `origin/main`)
- `npx vitest run tests/issue-1807.test.ts` (before and after merging
  `origin/main`)
- `npx vitest run tests/issue-1781.test.ts` (before and after merging
  `origin/main`)
- `npx vitest run tests/issue-1905.test.ts` (post-merge integration check for
  the current-main payload)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts
  tests/issue-1807.test.ts tests/issue-1905.test.ts tests/issue-1910.test.ts
  tests/issue-1472.test.ts -t
  "dynamic property add/read|#1903|#1781|#1807|#1905|#1910"` (after merging
  `origin/main` at `3fc48711b`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts
  tests/issue-1807.test.ts tests/issue-1905.test.ts tests/issue-1910.test.ts
  tests/issue-1472.test.ts -t
  "dynamic property add/read|#1903|#1781|#1807|#1905|#1910"` (after merging
  `origin/main` at `5bef49a5`)
- `npx vitest run tests/issue-1903.test.ts` (final handoff on 2026-06-07)
- `npx vitest run tests/issue-1472.test.ts -t "dynamic property add/read"`
  (final handoff on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts` (after merging `origin/main` at
  `3827daa96`)
- `npx vitest run tests/issue-1472.test.ts -t "dynamic property add/read"`
  (after merging `origin/main` at `3827daa96`)
- Rebuilt the PR #1262 `test262-standalone-results-merged.jsonl` artifact with
  `--max-unclassified-root-causes 0` after classifying
  `language/expressions/object/dstr` under the existing object-property bucket.
