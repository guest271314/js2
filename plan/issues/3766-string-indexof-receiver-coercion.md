---
id: 3766
title: "String.prototype.indexOf receiver coercion loses primitive undefined results"
status: done
sprint: current
created: 2026-07-28
updated: 2026-07-28
completed: 2026-07-28
priority: medium
horizon: s
feasibility: moderate
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: string-methods
goal: test262-conformance
assignee: "ttraenkler/codex-es5-string-indexof-receiver"
related: [2742, 3751, 3763]
loc-budget-allow:
  - src/codegen/type-coercion.ts
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/type-coercion.ts::coerceType
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
---

# #3766 — preserve primitive `undefined` during String receiver coercion

## Root cause

The ES5 `String.prototype.indexOf` T8/T9 tests construct their receivers through
`String(object)` and `new String(object)`. Their conversion methods return the
primitive `undefined` by falling off the function body.

Two representation gaps changed that result:

- native String coercion treated a void-returning method as a failed
  OrdinaryToPrimitive attempt instead of the successful primitive
  `undefined`;
- the host wrapper constructor deferred object coercion to the runtime bridge.
  Top-level Test262 code runs in the Wasm start section, before the host can call
  exported closure dispatchers, so it fell back to `"[object Object]"`.

The fix dispatches statically-known void-returning object-literal methods in
Wasm, observes string-hint ordering (`toString` before `valueOf`, skipping a
non-callable own property), and normalizes the result to the string
`"undefined"`. `new String(value)` now applies the shared ToString engine before
constructing the wrapper in both host and standalone modes.

## Stack dependency

This branch is stacked on ready PR #3751, which introduced native
`new String(value)` ToString coercion. Its commit is replayed above the latest
`origin/main`; #3766 extends that route to the host lane and completes the
void-result/fallback semantics. #3751 remains unchanged and is not merged by
this lane.

## Validation

- exact ES5 T8/T9 receiver shapes at module-start timing in host and standalone;
- focused method-order and exactly-once side-effect guards;
- same-SHA host/standalone A/B over the explicit ES5 and full
  `String.prototype.indexOf` cohorts;
- typecheck, lint/format, oracle ratchet, structural budgets, and focused
  wrapper/string regression suites.

### Same-SHA Test262 A/B

Both controls use dependency/base commit `27086a8313bb0c`, with only the #3766
working-tree patch added for the fixed arm.

| target     | explicit ES5 (34)    | full indexOf (47)      | status changes  |
| ---------- | -------------------- | ---------------------- | --------------- |
| host/GC    | 29→31 pass, 5→3 fail | 34→36 pass, 13→11 fail | T8/T9 fail→pass |
| standalone | 26→28 pass, 8→6 fail | 30→32 pass, 17→15 fail | T8/T9 fail→pass |

After excluding T8/T9, sorted `file/status/error_category/error_signature`
fingerprints are byte-identical between arms:

- host/GC:
  `ef5897e0c2aa169c65307df2b61296e58c5e45f7d1b7a5f42aab138bea14c3d9`;
- standalone:
  `6a859a54be467e19d13e91183db2f2fc90d9f3584b5003aa481292f1e9720148`.
