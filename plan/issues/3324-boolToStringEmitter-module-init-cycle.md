---
id: 3324
title: "tests/issue-2949-s5-2-eq.test.ts fails standalone with a module-init cycle: 'Cannot access boolToStringEmitter before initialization'"
status: ready
sprint: current
created: 2026-07-16
priority: medium
feasibility: medium
task_type: bug
area: codegen
goal: standalone-mode
related: [2949]
origin: "found as a side-effect of #3164 (#2040 A1 classifier flip) conflict-resolution validation, 2026-07-16 — pre-existing on main, unrelated to that PR"
---

# #3324 — module-init ordering cycle crashes a standalone test suite

## Problem

`tests/issue-2949-s5-2-eq.test.ts` fails at the suite level (not a single
assertion) on unmodified `origin/main` when run standalone:

```
ReferenceError: Cannot access 'boolToStringEmitter' before initialization
  at src/codegen/coercion-engine.ts:675
  via src/codegen/string-ops.ts:3587
  via src/codegen/expressions/builtins.ts:18
```

This is a circular module-import ordering bug: something in the
`builtins.ts` → `string-ops.ts` → `coercion-engine.ts` import chain reads
`boolToStringEmitter` before its declaring module has finished initializing.
Confirmed pre-existing (reproduces on a clean, detached `origin/main`
worktree) — not caused by, or related to, whatever PR happened to be in
flight when it was noticed.

## Task

1. Reproduce: run `tests/issue-2949-s5-2-eq.test.ts` standalone on current
   `main` and confirm the same stack trace.
2. Trace the actual import cycle (`coercion-engine.ts` ↔ `string-ops.ts` ↔
   `expressions/builtins.ts` — likely more modules involved) and find where
   `boolToStringEmitter` is referenced before its owning module's top-level
   initialization completes.
3. Fix the ordering — likely a lazy-init/factory-function indirection at the
   read site, or restructuring which module owns `boolToStringEmitter` to
   break the cycle. Don't just reorder imports if the underlying cycle is
   structural; fix the cycle itself.

## Acceptance criteria

- `tests/issue-2949-s5-2-eq.test.ts` passes standalone.
- No new circular-import warnings/errors introduced elsewhere.
