---
id: 2170
title: "standalone: `yield*` delegation unsupported in native generator lowering (clean #680 bail)"
status: ready
sprint: 62
created: 2026-06-15
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: iterators-generators
goal: standalone-mode
parent: 2157
depends_on: [2079]
---

# #2170 — yield* delegation (SF-3 of #2157)

## Problem

```ts
function* inner(){ yield 1; yield 2; }
function* g(){ yield* inner(); yield 3; }   // standalone: #680 CE
```

`buildNativeGeneratorPlan` returns null on `yield*`, so standalone hits the
scoped #680 compile diagnostic. #2079 explicitly deferred this.

## Fix direction

Add a `yield-star(innerSubject)` state-graph terminator: on resume, drive the
inner generator's `next()` and re-yield each `{value}` until the inner is
`done`, then transition to the next outer state. Reuse the native
`tryCompileNativeGenerator*` driver for the inner. Spec: §27.5.3.7 (the `yield*`
iterator-delegation algorithm — `next`/`return`/`throw` forwarding).

## Acceptance criteria

- `tests/issue-2157-*.test.ts` SF-3 `it.todo` passes, zero host imports.

## Source

Triage of #2157 (2026-06-15, sdev5), SF-3. Fetch §27.5.3.7 before implementing.
