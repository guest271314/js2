---
id: 52
status: active
created: 2026-05-20
started: 2026-05-20
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: true
---

# Sprint 52

**Planned**: 2026-05-20
**Started**: 2026-05-20

## Theme

> **Spec-completeness continuation + wasm closure bridge** — carry forward 16 unstarted S51 issues covering spec gaps, IR async groundwork, wasm-callable closures, and method closure caching; merge the 10 pending compiler PRs (#341–350) from the branch audit.

## Carried over from S51 (ready/blocked)

#1326c microtask queue standalone, #1373 IR async function, #1373b IR async CPS (blocked on #1373),
#1382 wasm closure bridge, #1387 with statement, #1392 benchmark hang, #1394 method closure caching,
#1396 forof-dstr externref default, #1400 ESLint valid wasm,
#1431 assignment operators dstr, #1432 param list rest dstr, #1433 DisposableStack lifecycle,
#1434 ToNumber/ToNumeric coercion, #1435 lexical early errors, #1436 global object/functions,
#1437 Math numeric edge cases, #1438 Map/WeakMap/WeakSet residuals

## New in S52

- Merge audit PRs: #341 #342 #343 #344 #345 #346 #347 #348 #349 #350
- #1364 class descriptor escalation (unblock #1334 first)
