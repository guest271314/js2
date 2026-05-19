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

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1364 | spec gap: class elements — method/field descriptor enumerable/configurable/writable (~700 fails) | high | blocked |
| #1373b | IR async Phase C: CPS lowering for await + async-return + async-throw | medium | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1326c | Async standalone Phase 1C: microtask queue + Promise.then chained-resolution (follow-up to #1326 Phase 1B) | medium | ready |
| #1373 | IR: claim async functions (async/await through IR path) | medium | ready |
| #1382 | structural: Wasm closures not JS-callable from host imports — bridge gap | high | ready |
| #1387 | feat: implement `with` statement — architect exploration of dynamic-scope compilation strategies | medium | ready |
| #1394 | class method-closure caching: C.prototype.method returns stable singleton closure | high | ready |
| #1400 | npm: compile ESLint package entry to valid Wasm | high | ready |
| #1431 | spec gap: assignment operators — destructuring completion, defaults, and compound side effects | medium | ready |
| #1432 | spec gap: parameter lists — rest/destructuring iterator semantics and default initializers | medium | ready |
| #1433 | spec gap: DisposableStack and AsyncDisposableStack lifecycle semantics | medium | ready |
| #1435 | spec gap: lexical grammar and syntax-directed early errors | medium | ready |
| #1436 | spec gap: global object descriptors and global function coercion/URI semantics | medium | ready |
| #1438 | spec gap: Map, WeakMap, and WeakSet residual collection semantics | medium | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1437 | spec gap: Math numeric edge cases beyond random source | low | in-progress |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1397 | codegen: static method dispatch ignores runtime property reassignment on typed receivers | medium | done |
| #1398 | report: edition filter on category table — per-category edition breakdown | low | done |
| #1434 | spec gap: ToNumber/ToNumeric coercion and unary operator edge cases | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
