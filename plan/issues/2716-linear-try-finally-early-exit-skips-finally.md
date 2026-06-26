---
id: 2716
title: "Linear backend: try/finally with early return/break inlines past the finally block"
status: ready
sprint: 66
created: 2026-06-26
updated: 2026-06-26
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen-linear
language_feature: standalone
goal: standalone-everything
parent: 2711
---
# #2716 — Linear try/finally early-exit skips the finally block

**Parent:** #2711 (standalone↔host differential parity gate).

## Root cause

In the linear backend, a `try { … return x; … } finally { … }` (or `break` /
`continue` out of the try) lowers the early exit by inlining straight to the
function/loop exit, **bypassing the finally block**
(`src/codegen-linear/index.ts:741`). Per spec, the finally block must run on
EVERY completion path out of the try — normal, `return`, `break`, `continue`,
and `throw`. Skipping it silently drops finally side effects (resource cleanup,
flag resets), a standalone-only correctness bug.

## Notes

- The naive `try{r=1;return r;}finally{r=2;}` case happens to agree across
  backends because the return value is captured before finally runs and finally
  only mutates a local — so the divergence is NOT caught by that shape. A child
  test must observe a finally side effect that is visible *after* the early
  exit (e.g. finally mutates an outer/captured cell that a second call reads, or
  finally itself performs a `return`/`break`).
- #1838 made the linear `try/catch` path **refuse loudly** rather than
  miscompile. The same policy applies here: if running the finally on the
  early-exit path is not implemented, the compile must `reportError` under
  `ctx.standalone`, not silently inline past it.

## Acceptance criteria

- [ ] finally runs on `return` / `break` / `continue` out of a `try` on the
      linear backend, OR the compile refuses loudly with a tracked gap.
- [ ] A cross-backend corpus entry observes the finally side effect and agrees
      with host.
