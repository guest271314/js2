---
id: 3487
title: "String.prototype.valueOf non-generic receiver traps illegal_cast (uncatchable) instead of throwing catchable TypeError"
status: ready
sprint: current
priority: high
horizon: s
feasibility: medium
task_type: bug
area: test262-conformance
goal: test262-conformance
created: 2026-07-20
---

## Problem

`test/built-ins/String/prototype/valueOf/non-generic.js` compiles to an
**uncatchable `illegal_cast` trap** on its receiver check, where the spec
requires `String.prototype.valueOf.call(nonString)` to throw a **catchable
`TypeError`**. This raised the main-side #3189 uncatchable-trap ratchet
`illegal_cast` category from **79 → 80**, which the #3335 trap-growth gate in
the baseline promoters (`write-run-cache-bot` / `promote-baseline` in
`test262-sharded.yml`, and `refresh-baseline.yml`) correctly REFUSED to bake in
— hard-failing every push:main baseline promote and **freezing the landing-page
test262 number for ~7h** (2026-07-19 18:21 → 07-20, stuck at 28294/43106 while
the real number had advanced to 28875/43106).

The freeze was cleared operationally by a one-cycle
`BASELINE_TRAP_GROWTH_ALLOW=1` re-anchor (the ratchet base moved to
illegal_cast=80, then the variable was reset to 0). **That override is a
TEMPORARY acknowledgment, NOT permanent acceptance.** This issue tracks fixing
the regression so the ratchet returns to **79** and the default `0` tolerance
stays strict.

## Evidence

Trap-gate log (push run 29713237555, head d0cc9028e, job `write-run-cache-bot` step 9):
```
[trap-growth] previous:  null_deref=166 illegal_cast=79 oob=49 unreachable=55
[trap-growth] candidate: null_deref=166 illegal_cast=80 oob=49 unreachable=55 (tolerance 0)
##[error]trap category "illegal_cast" grew 79 → 80 (+1) — Newly trapping: test/built-ins/String/prototype/valueOf/non-generic.js
```
Scope is exactly **+1, one test** — no other trap category moved, and it stayed
+1 across the whole host-restore wave (verified at the latest test-bearing tip
d0cc9028e).

The receiver lowering does a `ref.cast` of the `this` value to the String
struct type; when `this` is a non-String the cast traps (uncatchable) instead
of routing to a `TypeError` throw. Historically this test was
`compile_error`/`fail` (never passing — months of local baseline history), so
this is a **failure-mode regression (fail/CE → uncatchable trap), not a
pass→fail loss** — but an uncatchable trap is strictly worse for standalone (it
aborts the module) and trips the #3189 ratchet.

## Bisect range (culprit not yet pinned)

Baseline last clean at **#3419** (f48e67e0, illegal_cast=79); first tripped at
**01862f8a8** (#3421 merge, illegal_cast=80). Candidate merges in that window:
#3424 (release), #3425/#3426 (chores/plan — unlikely codegen), **#3423**
(standalone fn-expr strconcat param), **#3428** (#3430 strict compound/logical
assignment throws on failed [[Set]]), #3429, #3421. Most plausibly an
error-model codegen change (#3428 or #3423). Confirm by compiling
`String/prototype/valueOf/non-generic.js` at HEAD^1 of each candidate and
observing where the illegal_cast trap first appears.

## Acceptance

- `String.prototype.valueOf` on a non-String receiver throws a **catchable
  TypeError** (not an `illegal_cast` trap) in both host and standalone lanes.
- Baseline `illegal_cast` category returns to **79** (or lower) on the next
  promote, and the repo Actions variable `BASELINE_TRAP_GROWTH_ALLOW` stays at
  the default `0`.

## Context / incident

Landing-page freeze root-caused to this trap-growth gate refusal (NOT the
summary-sync, which was healthy). A low-velocity freeze (~4–6 merges) stayed
under the 25-commit `baseline-floor-staleness-alert` threshold, so it went
unnoticed for hours — see the companion observability change (loud ntfy at the
trap-gate refusal point) that surfaces a future occurrence within one push.
