---
id: 3065
title: "IR: claim non-terminating `if (cond) <stmt>;` guard at non-void body position (select↔builder parity, follow-on #1979)"
status: done
assignee: ttraenkler/sendev-irbucket
sprint: 71
created: 2026-07-06
updated: 2026-07-13
completed: 2026-07-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [1979, 2856, 1228, 1131]
---

# #3065 — IR: non-terminating `if (cond) <stmt>;` guard at a non-void body position

Child slice of the IR front-end migration epic **#2855** (drive the unintended
IR fallback buckets to zero). Reduces the dominant `body-shape-rejected` bucket
by **−1** (18 → 17) and closes a **select↔builder parity gap** that #1979 left
open.

## Root cause (why the selector rejected a shape the builder can already lower)

`#1979` (DONE, PR #1434) fixed `from-ast.ts` so a **non-terminating** then-arm
of a no-`else` `if` no longer incorrectly short-circuits the rest of the body.
`lowerStatementList` (`src/ir/from-ast.ts` ~759-782) forks on
`thenArmTerminates(thenStmt)`:

- **terminating** then-arm (`return`/`throw`) → the early-return rewrite
  `if (cond) <tail> else { <rest> }`;
- **non-terminating** then-arm (a side-effecting statement) → a converging
  guard: `br_if` to a `then` block that runs `lowerStmt(thenArm)` then falls
  through to a continuation block holding `<rest>`.

The builder's non-terminating arm accepts **any** statement `lowerStmt` handles
(`isPhase1BodyStatement`-shaped: assignment, call, nested guard, block, …). But
the **selector** (`isPhase1StatementList` in `src/ir/select.ts`) only let a
non-terminating then-arm through when it was a valid **void tail** — the
`isVoidReturn && ExpressionStatement` arm of `isPhase1Tail`. For a **non-void**
function whose guard is followed by more statements and a value return — the
canonical day-of-week `fdow` shape:

```ts
function fdow(y: number, m: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let yr = y;
  if (m < 2) yr = yr - 1; // non-terminating guard, non-void fn
  const d = (yr + ((yr / 4) | 0) - ((yr / 100) | 0) + ((yr / 400) | 0) + t[m] + 1) % 7;
  return (d + 6) % 7;
}
```

`isPhase1Tail(yr = yr - 1, isVoidReturn=false)` fell through to
`shapeNo("tail-unhandled", …)`, demoting `fdow` to legacy even though the
builder could lower it end-to-end. Under **#2138 IR-first** a select↔builder
drift like this is worse than a demote — a claimed-but-unlowerable shape traps
as `unreachable`. Here the drift was the _opposite_ direction (builder ahead of
selector), so it only cost a claim, but it is exactly the parity the migration
must close.

## Why this is now a clean, mergeable −1 (contagion no longer blocks it)

The #2856 Step-2 analysis (2026-07-03) concluded "no incremental PR can reduce
this bucket" because the `call-graph-closure` fixpoint demoted any leaf whose
**caller** was unclaimed — moving the count into `call-graph-closure` (net-zero,
gate fails on that growth). That was pre-#2858. **#2858 (PR #2752, merged
2026-07-06) disabled the caller-direction demotion in JS-host mode** for
functions without a callable param (`demoteOnLegacyCaller = jsHostExterns !==
true`, `select.ts` ~596). The gate runs in host mode, so a **pure leaf** like
`fdow` (no callees, no callable param) now stays claimed regardless of its
unclaimed caller `renderCal`. Verified empirically: `body-shape-rejected`
18 → 17, `call-graph-closure` stays **0**, **zero** post-claim demotions.

## Fix (selector-only, mirrors the builder exactly)

`src/ir/select.ts`:

1. Added a `thenArmTerminates(stmt)` helper — an **exact** mirror of the
   identically-named helper in `from-ast.ts` (return/throw, or block/if-else
   whose every path terminates). Keeping the two in lockstep is the whole point:
   the selector must agree with the builder on the terminating/non-terminating
   fork.
2. Split the non-tail `if (cond)`-no-`else` arm of `isPhase1StatementList` on
   `thenArmTerminates`:
   - terminating → unchanged (Phase-1 **tail** then-arm + `<rest>` as the else
     list);
   - non-terminating → require the then-arm to be an `isPhase1BodyStatement`
     (the exact set `lowerStmt` accepts), with a cloned scope so arm-local
     `let`s don't leak, `inLoop=false` (a `break`/`continue` in the guard stays
     rejected; a `return` makes `thenArmTerminates` true and takes the other
     arm), then `continue` so the outer loop validates `<rest>` through to the
     tail — matching from-ast's `lowerStatementList(rest)` in the continuation
     block.

No `from-ast.ts` change was needed — the #1979 converging-guard path already
lowers this shape; it was simply unreachable from the selector for non-void
functions.

## Verification

- `pnpm run check:ir-fallbacks`: `body-shape-rejected` **18 → 17**,
  `call-graph-closure` 0 (unchanged), post-claim demotions **0**. Baseline
  ratcheted in `scripts/ir-fallback-baseline.json`.
- `JS2WASM_IR_SHAPE_DIAG=1 … --shape-diag`: `fdow` leaves the rejection set; no
  other function shifts and no new arm appears (a pure −1, not a relabel).
- New `tests/issue-2856-nonterminating-if-guard.test.ts` (8 cases): legacy/IR
  value parity + zero post-claim demotions + **IR-path-exercised** (bytes
  differ from the `experimentalIR:false` compile — no vacuous legacy pass) for
  the minimal guard, both guard arms, the full `fdow` Zeller computation across
  5 (y,m) pairs, block then-arm, consecutive guards, nested guard, guard +
  following loop, and a REGRESSION case proving the terminating early-return
  rewrite still fires.
- `tests/ir-algorithms-cluster.test.ts`, `ir-if-else-equivalence.test.ts`,
  `issue-1979.test.ts`, `issue-1228.test.ts` — 55 pass, no regression.
- Equivalence gate shards green (no new regressions vs baseline).
- `tsc` / prettier / biome clean.

## Notes for the bucket owner (#2856, ttraenkler/fable-2856exec)

This slice is independent of the algorithms.ts whole-component work: it only
touches the non-tail if-no-else arm of `isPhase1StatementList` + a new helper,
and ratchets the baseline by 1. If both land, the baseline number reconciles to
whatever the merged corpus produces (re-run `--update-on-decrease`). The
capability (non-terminating guard in non-void bodies) is broadly reusable beyond
the corpus.
