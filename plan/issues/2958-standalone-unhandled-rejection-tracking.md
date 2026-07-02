---
id: 2958
title: "Standalone: unhandled-rejection tracking — report rejected promises with no handler at drain/event-loop exit"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, runtime
language_feature: promises
goal: standalone-mode
related: [2867, 2632, 1326]
origin: "2026-07-02 July Fable audit §2 (no unhandled-rejection story on the native carrier)"
---

# #2958 — a rejected $Promise with no reactions vanishes silently

## Problem

The native standalone Promise carrier (`src/codegen/async-scheduler.ts`:
`$Promise` state struct + microtask ring + `__drain_microtasks` /
`__run_event_loop`) has no unhandled-rejection tracking: a promise that
settles rejected with an empty callback list is simply garbage — the
program exits 0 with the error swallowed. Host mode inherits the JS host's
reporting; standalone has nothing. This both diverges from spec-required
HostPromiseRejectionTracker observability and hides real failures in
standalone runs (a debugging hazard for every carrier issue).

## Approach

Mirror Node's default behavior at the natural exit points:

1. Track: on reject with empty reactions, append the promise to a
   `$rejectedUnhandled` list; on later `.then/.catch` attach, remove it.
2. Report: at the end of `__drain_microtasks` when the ring is empty (and
   at `__run_event_loop` termination), if the list is non-empty, print
   `Unhandled promise rejection: <stringified reason>` via the existing
   fd_write path (reuse #2962's payload stringification when it lands;
   fall back to the tag/typeof classifier until then) and set a nonzero
   exit code from `_start`.
3. Keep it cheap: no per-turn scanning; list ops are O(1) at settle/attach.

## Acceptance criteria

- `Promise.reject(new Error("x"))` with no handler: standalone binary
  prints the report and exits nonzero; adding `.catch` silences it.
- Late attach within the same drain (reject → microtask → attach) does NOT
  report (matches JS semantics for same-turn handling).
- No behavior change in host mode; host-free floor net-positive or neutral.
