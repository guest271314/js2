---
id: 2165
title: "Standalone Promise/async conformance residual (~223 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: medium
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: promise-async
goal: standalone-mode
parent: 1116
depends_on: [1326]
---

# Standalone Promise/async conformance residual

## Problem

Promise resolution and async error handling landed in #1116 (`done`, sprint
55); the standalone microtask scheduler #1326 is `in-review` and Promise
subclass capability #1694 is in `backlog`. The host-vs-standalone baseline
diff (sha `31fa7e099`, 2026-06-15) shows **223 tests pass in host mode but
fail standalone**, attributed to Promise/async semantics.

## Evidence

- Gap category: `built-ins/Promise` 180 plus async language tests;
  `Promise_resolve`/`Promise_reject`/`Promise_then`/`__create_async_generator`/
  `__make_callback` host-import leaks.

## Acceptance criteria

- Standalone pass count for `built-ins/Promise` + async language tests rises
  toward host parity.
- No `Promise_*` / `__make_callback` host-import leak for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1116. Depends on the standalone microtask scheduler (#1326)
landing. Part of sprint-62 standalone catch-up (rank 11 by gap impact).
