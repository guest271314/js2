---
id: 2941
title: "IR: if statement inside loop bodies (isPhase1BodyStatement has no if arm)"
status: blocked
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2856
depends_on: [2939]
related: [2855, 1376]
---

# #2941 — IR: `if` inside loop bodies

Child of #2856 (`body-shape-rejected` → 0), under the IR migration epic
#2855. **North star: route everything through the IR; backends are the only
fork.**

## Problem

`isPhase1BodyStatement` (src/ir/select.ts, the loop-body statement checker)
has **no arm for `IfStatement`** — `if` is only accepted by the
statement-list logic (tail reinterpretation / no-else non-tail extension).
So a plain conditional inside a `for`/`while` body rejects the whole
function as `body:stmt-IfStatement`. Exact instances (from
`pnpm run check:ir-fallbacks -- --why`, #2856 instrumentation), all in
`website/playground/examples/js/algorithms.ts`:

| function       | shape                                                          |
| -------------- | --------------------------------------------------------------- |
| `quicksort`    | `if (arr[j] <= pivot) { i++; …swap… }` inside nested for-loops   |
| `joinNums`     | `if (i > 0) s = s + ",";` inside a for-loop                      |
| `binarySearch` | `if (v === target) return mid;` + else-if chain inside a while   |

3 of the 31 `body-shape-rejected` functions. Note `binarySearch` has a
`return` inside the loop — the lowering must handle early-exit-from-loop
control flow, not just statement-shaped conditionals.

## Blocked on #2939 (contagion)

These functions' caller is `algorithms.ts::main`, demoted on `console`. The
selector's fixpoint loop (src/ir/select.ts ~415) re-demotes any claimed
function whose caller/callee is unclaimed (`call-graph-closure`), so landing
this slice before #2939 would move the 3 counts into `call-graph-closure`
and FAIL the gate on that growth. Flip to `ready` when #2939 merges.

## Direction

- Selector: add an `IfStatement` arm to `isPhase1BodyStatement` — condition
  must be Phase-1, then/else branches recurse into the body-statement check
  (branch-scoped `Set(scope)` copies, mirroring the statement-list arm).
- from-ast/lowering: an IR `if` in statement position (no result value),
  including `return` inside the branch (early exit from within a loop —
  verify against the existing tail-`if` lowering; the Wasm side is
  `if`/`else` blocks with `br`/`return`; watch stack balance for the no-result
  form).
- Keep the selector change additive (dev-2138f is inverting the selector
  default in parallel — do not restructure, only add arms).

## Acceptance criteria

1. `body-shape-rejected` drops by 3 (the rows above); `call-graph-closure`
   does not grow; ratchet banks the decrease.
2. Equivalence parity for `quicksort`/`joinNums`/`binarySearch` (IR vs
   legacy), including the in-loop `return` path.
3. `pnpm run check:ir-fallbacks` gate passes; no test262 regression.
