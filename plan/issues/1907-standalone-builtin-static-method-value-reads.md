---
id: 1907
title: "standalone: built-in static method value reads without __get_builtin (#1888 S6-b)"
status: in-progress
pr: 1287
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: built-ins, objects
goal: standalone-mode
parent: 1888
related: [1888, 1902, 1472]
test262_bucket: standalone-dynamic-object-property
test262_count: 8163
claimed_by: codex-developer
claimed_at: 2026-06-07T07:31:05.107Z
---

# #1907 — Built-in static method value reads without `__get_builtin`

## Problem

`#1902` fixed the constant-only `Math.PI` / `Number.MAX_SAFE_INTEGER` slice by
letting existing native constant emitters run under standalone. The real
`#1888` Slice 6-b gap remains: reading a built-in static method as a value still
routes through `__get_builtin` and is refused.

Examples:

```ts
const isArray = Array.isArray;
const keys = Object.keys;
const stringify = JSON.stringify;
```

These should lower to native callable values or fail loud for the specific
unsupported built-in/property pair, not to the generic `__get_builtin`
standalone refusal.

## Scope

- Implement the first demand-driven built-in static method value reads needed
  by the standalone bucket.
- Start with `Array.isArray`, `Object.keys`, and `Object.defineProperty` or
  `Object.getOwnPropertyDescriptor` if their native helper signatures are
  already usable as closures.
- Reuse the `#1888` built-ins-as-static-globals design. Keep binary size
  proportional to referenced built-ins.

## Acceptance Criteria

- Focused tests show at least two built-in static method values can be read and
  called under `target: "standalone"` with no `env::__get_builtin` import.
- Unsupported `Builtin.prop` pairs fail loud with `#1907` or `#1888 S6-b`
  cited.
- `Math`/`Number` constant tests from `#1902` remain green.
- Default/gc behavior is unchanged.

## Implementation Notes

- Added standalone built-in static method closure emission for `Array.isArray`,
  `Object.keys`, and `Object.getOwnPropertyDescriptor`.
- `Array.isArray` method values share the direct-call externref predicate:
  WasmGC vec `ref.test` under no-host targets, with the JS host predicate only
  in host mode.
- `Object.keys` method values preserve the standalone object-runtime `$ObjVec`
  `externref` return contract so `__extern_length` / `__extern_get_idx`
  consumers remain host-free.
- Unsupported standalone `Builtin.prop` value reads now fail with a
  `#1907 / #1888 S6-b` diagnostic instead of falling into `__get_builtin`.

## Validation

- `npm test -- tests/issue-1907.test.ts tests/issue-1888-s6c.test.ts`
- `npm run typecheck -- --pretty false`
- `npm test -- tests/issue-1678.test.ts`
- `npm test -- tests/issue-1472.test.ts -t "Reflect.ownKeys routes"`
- `npx prettier --check src/codegen/property-access.ts src/codegen/expressions/calls.ts tests/issue-1907.test.ts tests/issue-1888-s6c.test.ts plan/issues/1907-standalone-builtin-static-method-value-reads.md`

## Final Findings

- Implementation PR #1263 exists, was ready/non-draft, and is now merged into
  `main` at `3827daa96`; follow-up PR #1267 also merged, and PR #1287 tracks
  this redispatch verification update.
- Final codex-developer verification on this branch found no additional
  implementation work outstanding; the scoped validation commands above passed
  again on 2026-06-07 after merging current `origin/main`.
- `origin/main` was fetched at `d6957d5d` and merged into `symphony/1907` with
  merge commit `9f350d0a`. The merge brought in later sprint issue/report
  updates without #1907 conflicts.
- Scoped validation passed again on 2026-06-07T09:13+02:00 after that final
  main merge: the focused #1907/#1888 tests, typecheck, #1678 Array.isArray
  regression tests, the targeted #1472 Reflect.ownKeys standalone route, and
  formatting.
- Codex redispatch verification on 2026-06-07T09:20+02:00 confirmed
  `origin/main` is still an ancestor of `symphony/1907`, reran the same scoped
  validation successfully, and found PR #1287 open, ready/non-draft,
  mergeable, and green on remote head `ab1d8c19d`.
- Publishing the refreshed issue handoff commit was rejected on
  2026-06-07T09:23+02:00 with GitHub GH006 because PR #1287 is already in the
  merge queue and queued branch heads cannot be updated. This local handoff is
  left `in-progress`; the remote PR remains queued at `ab1d8c19d`.
- Redispatch verification on 2026-06-07T08:19+02:00 found the implementation
  already merged, branch synced with `origin/main`, PR #1287 opened
  ready/non-draft, and the same scoped validation still passing.
- Codex verification on 2026-06-07T09:11+02:00 found PR #1287 still open,
  ready/non-draft, green on the remote head, and accepted in the merge queue at
  position 11 before the local main-sync publish. This handoff keeps the issue
  `in-review` with `pr: 1287` for the PR-status poller.
- Codex verification on 2026-06-07T09:34+02:00 reran the same scoped
  validation successfully, confirmed `origin/main` remains an ancestor of local
  `symphony/1907`, and found PR #1287 still open, ready/non-draft, green, and
  queued at position 11 on remote head `ab1d8c19d`. The local handoff remains
  `in-progress` because the queued branch cannot accept the unpublished docs
  commits.
- Publishing the local handoff history was rejected again on
  2026-06-07T09:37+02:00 with GitHub GH006 because PR #1287 is still in the
  merge queue. The remote PR remains queued on `ab1d8c19d`; this local issue
  file intentionally stays `in-progress` until the queue lock is gone or the PR
  merges.
