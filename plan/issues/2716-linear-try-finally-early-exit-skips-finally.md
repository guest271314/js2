---
id: 2716
title: "Linear backend: try/finally with early return/break inlines past the finally block"
status: done
sprint: 67
created: 2026-06-26
updated: 2026-06-26
completed: 2026-06-26
assignee: ttraenkler/dev1
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
  test must observe a finally side effect that is visible _after_ the early
  exit (e.g. finally mutates an outer/captured cell that a second call reads, or
  finally itself performs a `return`/`break`).
- #1838 made the linear `try/catch` path **refuse loudly** rather than
  miscompile. The same policy applies here: if running the finally on the
  early-exit path is not implemented, the compile must `reportError` under
  `ctx.standalone`, not silently inline past it.

## Acceptance criteria

- [x] finally runs on `return` / `break` / `continue` out of a `try` on the
      linear backend (implemented — not just a loud refusal).
- [x] A cross-backend corpus entry observes the finally side effect and agrees
      with host (`control/try-finally-early-exit`).

## Resolution (2026-06-26, dev1)

Implemented finally-replay rather than a loud refusal (a refusal would regress
floor programs that currently fall through; replay only _adds_ the missing
finally runs). Added `fctx.finallyStack` (`src/codegen-linear/context.ts`,
`FinallyEntry`): each `try { … } finally { … }` pushes an entry recording the
break/continue nesting at try-entry, compiles the try body, pops, then runs the
finally inline for normal fall-through.

The early-exit handlers in `compileStatement` (`src/codegen-linear/index.ts`)
replay the applicable finally blocks (innermost first) before the jump:

- **`return`** replays every enclosing finally. The return value is stashed in a
  temp first so a finally that mutates the source global can't clobber the
  in-flight value (`try { return g+1 } finally { g=99 }` → returns the pre-finally
  value).
- **`break` / `continue`** replay only the finallys that sit _between_ the jump
  and its target loop/switch (`entry.breakDepth/continueDepth === stack.length`),
  so a `break` of an inner loop _inside_ the try does not prematurely run the
  try's finally. Replaying inline keeps `blockDepth` balanced, so the `br` depth
  is unchanged.

`localMap` is snapshotted/restored around each replay so a block-scoped decl in
the finally doesn't leak its binding.

**Loud refusal kept for one case:** a finally that itself performs a
`return`/`break`/`continue` needs completion-override semantics the replay model
doesn't implement → `finallyBlockHasOwnEarlyExit` throws a clear compile error
(like the try/catch gate, #1838) rather than miscompile.

Verified: early return / break / continue run finally; nested finally replays
innermost-first; return value preserved across finally; inner-loop break does NOT
run the try-finally; normal fall-through runs finally exactly once; finally-with-
own-return refused. Tests: `tests/issue-2716.test.ts` (8) +
`control/try-finally-early-exit` cross-backend corpus entry. Full linear suite
(19 files / 167 tests) + cross-backend-diff green; tsc clean.
