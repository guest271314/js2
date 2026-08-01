---
id: 3953
title: "verify the #2097 high-water raise actually executes on a real merge, and make its silence loud — a floor that is too low must stop being cost-free"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci, merge-queue, test262
goal: release-pipeline
depends_on: [3611]
related: [2097, 3448, 3467, 1078, 2562]
---

# The two halves of #3611 that a code PR cannot close

#3611 fixed the **mechanism**: `promote-baseline` lacked a status-check function, so
GitHub propagated the #3448 HIT-path skip through `merge-report`'s `always()` and into
it, and the #2097 standalone high-water raise was skipped on **30 of 30** available
push:main runs. That change is structural and reviewable.

Two of its acceptance criteria are **not** structural, and are carried here rather than
ticked off the tests.

## 1. Observable verification — the part that must not be inferred

**A structural test asserting the shape of the `if:` is a regression guard, not
evidence the bug is fixed.** It would keep passing while some _other_ propagation path
kept the job skipped. The only thing that settles it is a real merge:

- [ ] After #3611 lands, a **merge-queue landing** produces a `Test262 Sharded`
      `push:main` run whose `promote merged report to main baseline` job has conclusion
      **`success`** — cited **by run id** in this issue.
- [ ] Re-run the same audit that produced the 30/30 (`.tmp/promote-audit.sh` in the
      #3611 branch, or the equivalent: enumerate `push:main` runs of workflow
      `265204744` and print that job's conclusion). Expect `success` on runs after the
      fix; the pre-fix runs stay `skipped` and are the control.
- [ ] Confirm the **effect**, not just the job status: `scripts/check-standalone-highwater.mjs`
      target actually advanced (mark `pass`/`sha` changed on main), because a job can
      succeed while its update step no-ops.

**Do not close this on the tests passing.** That is the whole point of splitting it out.

## 2. Make the silence loud (#3611 AC4)

The reason this survived a week is not that the skip was subtle — it is that
**nothing anywhere reports a skipped raise.** A high-water mark that is too **low**
never fires its gate, so the permissive direction is completely silent. Combined with
two jobs whose names both start `promote …` (one green on all 30 runs, and it is _not_
the one carrying the raise), a reader skimming a run summary sees green and moves on.

- [ ] If the raise is skipped on a `push:main` run, something says so — an annotation
      on the run, or an alert like the existing
      `baseline-floor-staleness-alert.yml` / `trap-tolerance-staleness-alert.yml`.
- [ ] If the committed mark is more than N landings / hours older than the newest
      promoted standalone report, that is reported. There is precedent to copy:
      `baseline-floor-staleness-alert.yml` already does this shape for a sibling
      artifact.
- [ ] The detector must have a **third state**. "Could not determine the mark's age"
      must not render as "fresh" — that is the same false-empty that made the original
      bug invisible, and it is a documented recurring failure in this repo.

**Cheapest useful version:** a step in `promote-baseline` that fails (or annotates)
when the raise did not run, plus a scheduled staleness check on the mark. The bar is
_"a floor that is too low stops being cost-free"_, not full observability.

## 3. Also open, tracked in #3611, NOT here

**AC5 — `refresh-baseline.yml` disposition.** It is `disabled_manually` and **the
reason is unrecorded** (searched `plan/`, `docs/`, `.claude/memory/`; nothing states
one). Re-enabling is a repo-config change with standing effect that restarts an
8-hourly cron, cannot be expressed in a code diff, and would be inferring permission.
It should be its own change with its own justification — and it should come **after**
criterion 1 above confirms the primary path works, because repairing the primary beats
re-enabling a backstop.

AC6 (the runbook naming a lever that returns HTTP 422) is **done** in #3611.

## Why this is a separate issue rather than a checkbox left open

A criterion that can only be verified after merge, on someone else's PR landing, is
invisible if it stays as an unticked box inside a `done` issue — that is how the
original defect stayed unnoticed for a week. Giving it an id gives it an owner and a
queue position.
