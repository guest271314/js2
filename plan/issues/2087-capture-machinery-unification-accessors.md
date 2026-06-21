---
id: 2087
title: "capture-machinery unification: object-literal accessors must use the canonical boxedCaptures ref-cell path"
status: backlog
sprint: Backlog
created: 2026-06-11
updated: 2026-06-21
priority: low
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: closures
goal: core-semantics
related: [2011, 1999]
origin: "2026-06-11 analysis program (report 05 §2b); stub 08-A2"
---

# #2087 — parallel capture path captures copies

## Problem

Object-literal accessors build a parallel closure path that captures
COPIES — writes through accessors never reach the outer scope and
getter/setter pairs don't share state (#2011). Compound assignment on
captured strings diverged the same way (#1999, fixed point-wise). The
parallel path will keep breeding divergences until it's retired.

## Root cause

`src/codegen/literals.ts:299-528` parallel accessor-closure path vs the
canonical `ctx.boxedCaptures` ref-cell machinery owned by closures.ts
(threaded through 13 files).

## Fix direction

Migrate accessor closures onto boxedCaptures (one shared ref cell per
captured binding across all callbacks in a scope); delete the parallel
path. Subsumes the structural half of #2011. Senior-dev lane. Full
analysis: plan/log/analysis-2026-06/05-structure-review.md §2b.

## Acceptance criteria

- #2011's three repros match Node (shared getter/setter state, outer
  visibility)
- Single capture implementation; #1999 tests stay green

## Dupe check

#2011 is the symptom issue (stays open as acceptance vehicle); no issue
owns the machinery unification. New (analysis program).

## Disposition (2026-06-21, sd-1 investigation) — functional bug already fixed; refactor backlogged

The functional defect this issue targets is **already fixed on current main**;
what remains is a pure, high-risk, no-behavior-change refactor. Backlogged out
of sprint 64 (priority low).

- The "parallel path captures COPIES" premise (literals.ts:299-528) is **stale**.
  #2128 already wired the accessor path into the canonical machinery:
  `compileObjectLiteralWithAccessors` threads a per-literal
  `accessorSharedRefCells` (SharedRefCellMap) + `forceMutableCaptures` into
  `compileArrowAsCallback`, which reconciles them with `fctx.boxedCaptures`.
  Accessor getter/setter pairs already share **one** ref cell per binding.
  #2011's module-scope residual was fixed separately in declarations.ts.
- Acceptance vehicles all green on main: issue-2011, issue-2128, issue-1999,
  accessor-side-effects = **38/38**; the three #2011 repros match Node.
- Remaining work = deleting the now-redundant `sharedRefCells` scaffolding to
  converge fully on `boxedCaptures` — threaded through ~13 files, **zero new
  passing tests**, severe regression surface (capture / late-import machinery is
  a known minefield). Pure maintainability, not a bugfix.

**Recommendation if revived**: do NOT attempt the 13-file rewrite blind — write
an architect spec naming the exact deletion plan + a regression-guard list
first. A low-risk partial that preserves the intent: add a **strict invariant
test** asserting the accessor-path and the ordinary-closure-path resolve a
captured binding to the SAME `boxedCaptures` cell, locking the convergence
#2128 achieved against future regression.
