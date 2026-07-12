---
id: 3198
title: "default lane: Promise combinator callbacks never execute — vacuous slice (218 fails)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: medium
feasibility: hard
task_type: bug
area: codegen
es_edition: ES2018
language_feature: promise-combinators
goal: core-semantics
sprint: current
horizon: m
umbrella: 3184
related: [3184, 2614, 2613, 2623, 2940]
origin: "2026-07-12 Fable codebase audit §F1; slice of #3184"
---

# #3198 — Promise-combinator vacuous slice (218)

Sub-slice of **#3184**. This slice owns the **Promise-combinator** half; the
for-await-of half is **#3197**.

## Problem

`built-ins/Promise/{any,race,all,allSettled,prototype}` carries **218**
`vacuous: harness-wrapper callback never executed (#2940)` records on the
default (JS-host) lane: the combinator's resolve/reject/element callbacks —
and therefore every assertion — never run, yet the test reports success. This
is the second-biggest slice of the 1,544-record vacuous family after
for-await-of (#3197).

## Distinct from #2614 / #2613 (READ THIS BEFORE CLAIMING)

- **#2614** (`blocked`, assignee senior-developer) = "read the constructor's
  own `resolve` + callable resolve/reject element functions" (~45 fails). That
  is a spec-detail fix for combinator tests that **do run**. This slice is the
  **vacuous-drive** class — tests where the callback chain never executes at
  all. Mechanistically different, same method surface.
- **#2613** (`blocked`) = await-thenable assimilation (~15). Not this.
- The audit (§F1) explicitly recommends **un-blocking or re-slicing #2614**
  for this 218. Coordinate: confirm whether the vacuous root cause is shared
  with #3197's async-drive gap (likely) — if so, #3197's fix may flip a large
  share of this bucket for free; remeasure before implementing.

## Reproduction path (verified anchors)

Combinator dispatch is in `src/runtime.ts`: `Promise_all` (`:13450`),
`Promise_race` (`:13455`), `Promise_allSettled` (`:13460`), `Promise_any`
(`:13465`); the `NewPromiseCapability(C)` / `Construct(C, «executor»)` path
(#2614) at `:12445` and `:13341-13400`. Trace whether the combinator's
per-element `resolve`/`reject` callbacks are ever invoked, or whether the host
Promise bridge swallows the first tick.

## Acceptance criteria

1. Root-cause note: which link drops the callback (combinator entry →
   per-element resolve/reject → settle → $DONE).
2. ≥ 120 of the 218 vacuous Promise-combinator records flip to genuine pass OR
   honest assertion failures (no longer vacuous) on the default lane.
3. No standalone-lane regressions.
4. Do NOT absorb #2614's constructor-resolve-reading fix unless it falls out
   for free; if it does, note the overlap and coordinate the merge with the
   #2614 owner.

## Coordination (priority lowered: overlaps blocked/active Promise work)

Priority is **medium**: this slice's file (`src/runtime.ts` Promise region)
overlaps blocked #2614 (senior-developer) and active Promise-capability work
(dev-promise-cap). Confirm no in-flight lock on the combinator dispatch region
before claiming; prefer to land after or alongside #3197 (shared root cause).

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F1.
