---
id: 2939
title: "IR: host-global references (console, document) — route through the legacy host-import path"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2856
related: [2855, 1371, 1376]
---

# #2939 — IR: host-global references (`console`, `document`)

Child of #2856 (`body-shape-rejected` → 0), grandchild of the IR migration
epic #2855. **North star: route everything through the IR; backends are the
only fork.** This is the keystone slice — the largest single cause in the
`body-shape-rejected` bucket AND the root of the `call-graph-closure`
contagion.

## Problem

`isPhase1Expr` (src/ir/select.ts) rejects any identifier that is not in the
function-local scope set (`expr:ident-not-in-scope`). Host globals are never
in scope, so **every function that logs or touches the DOM demotes to
legacy**. Exact counts from `pnpm run check:ir-fallbacks -- --why`
(instrumentation from #2856):

- `document` ×16 — all `main`/`bench_*` drivers + `el()` helpers across
  `website/playground/examples/{benchmarks,dom,js}/…`
- `console` ×2 — `js/algorithms.ts::main`, `js/classes.ts::main`

That is 18 of the 31 `body-shape-rejected` functions. (The other 3
`expr:ident-not-in-scope` hits are module-scope bindings — #2940.)

## Why this slice must land FIRST (the contagion trap)

The selector's fixpoint loop (src/ir/select.ts ~415) demotes any claimed
function whose local caller OR callee is unclaimed, tagging it
`call-graph-closure`. The host-global references sit in the `main` drivers —
the call-graph roots — so they pin the whole example out of the IR:
shape-fixing any leaf (predecessor's `fibIter` experiment) merely MOVES the
count from `body-shape-rejected` to `call-graph-closure`, and the gate fails
on that growth. Clearing the host-global root drops **both buckets in one
PR**: `body-shape-rejected` loses the 18 rows and `call-graph-closure`
shrinks as the freed drivers unlock their callees. Bank it with
`pnpm run check:ir-fallbacks -- --update-on-decrease`.

## Direction

The IR selector accepts `console.<m>(…)` / `document.<m>(…)` shapes and the
IR lowering resolves them to **the same host-import path the legacy backend
uses** — per mode:

- Legacy `console`: source-scan registers per-variant host imports
  (`src/codegen/index.ts:6530`); **WASI/standalone lowers console.log/error
  via `fd_write` / `node:fs::writeSync`** (`src/codegen/declarations.ts:1072`,
  `index.ts:6594+`). The IR path must hit these same imports/fallbacks.
- Legacy `document`: declared-globals host-import machinery
  (`src/codegen/index.ts:14007–14312`, `usesDomGlobals` scan) — host-only by
  nature.

**DUAL-MODE RULE (hard requirement):** in standalone mode these either lower
to the existing WASI/native fallbacks the legacy backend already uses, or the
IR **refuses cleanly to legacy** for that mode — never a new bare host import
without a standalone fallback. Match the legacy backend's behaviour per mode
exactly; equivalence parity is the acceptance bar.

Follow the `Math.*` whitelist precedent (#1371, `isPhase1Expr` call arm) for
the selector shape; the lowering side needs the late-import funcIdx-shift
discipline (see `addUnionImports` notes in CLAUDE.md and the #2918 lesson —
name-based repoint, never raw indices, when imports are added late).

## Acceptance criteria

1. `body-shape-rejected` drops by the host-global rows (18) and
   `call-graph-closure` does NOT grow — both shrink together; the ratchet
   banks the decrease (`--update-on-decrease` baseline commit in the PR).
2. `fibIter` (benchmarks/fib.ts) is IR-claimed — regression test for the
   contagion (the predecessor's proof case).
3. Equivalence tests: IR output for `console.log` / `document.*` examples
   matches legacy output in JS-host mode; standalone mode matches legacy
   standalone behaviour (fd_write path for console; clean refusal or parity
   for document).
4. No new host import without a standalone fallback (dual-mode rule).
5. `pnpm run check:ir-fallbacks` gate passes; no test262 regression.
