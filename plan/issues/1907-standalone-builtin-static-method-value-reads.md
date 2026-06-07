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
claimed_at: 2026-06-07T06:45:05.679Z
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
- `origin/main` was fetched and merged into `symphony/1907` through
  `5b495ba47` before the final branch push. The merge brought in later sprint
  issue/report updates without #1907 conflicts.
- Scoped validation passed again after that final main merge: the focused
  #1907/#1888 tests, typecheck, #1678 Array.isArray regression tests, the
  targeted #1472 Reflect.ownKeys standalone route, and formatting.
- Redispatch verification on 2026-06-07T08:19+02:00 found the implementation
  already merged, branch synced with `origin/main`, PR #1287 opened
  ready/non-draft, and the same scoped validation still passing.
- Codex verification on 2026-06-07T08:28+02:00 reran the issue-scoped
  validation on `symphony/1907`; all commands passed, PR #1287 was still open
  and ready/non-draft, and the branch remained current with `origin/main`.
- Codex verification on 2026-06-07T08:34+02:00 reran the same scoped validation
  on the current branch; all commands passed, PR #1287 remained open and
  ready/non-draft, and `origin/main` was still an ancestor of `HEAD`.
- Codex verification on 2026-06-07T08:40+02:00 reran the issue-scoped
  validation on the current branch; all commands passed, PR #1287 was open,
  ready/non-draft, mergeable, and its remote-head checks were green.
- Final push of local verification commit `a110392e8` was rejected by GitHub
  with GH006 because PR #1287 is already in the merge queue. The queue entry was
  `QUEUED` at position 15, enqueued at `2026-06-07T06:26:03Z`; leave this issue
  `in-progress` until the queued PR lands or the branch is intentionally
  dequeued for another update.
- The remote PR branch still has `pr: 1287` and was already queued, but this
  local handoff leaves the issue `in-progress` because the final publish update
  could not be pushed while the branch is queue-protected.
- Codex verification on 2026-06-07T08:47+02:00 reran the same issue-scoped
  validation on the current local branch; all commands passed, `origin/main`
  remains an ancestor of `HEAD`, and PR #1287 is still open, ready/non-draft,
  mergeable, green on the remote head, and queued at position 14. The local
  branch still contains unpublished issue-doc verification commits because the
  queued PR head is protected from further pushes.
