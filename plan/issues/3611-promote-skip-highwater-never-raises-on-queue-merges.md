---
id: 3611
title: "promote-baseline skips on the per-SHA-reuse path, so the #2097 standalone high-water never re-raises on queue merges — the floor drifts permissively, silently"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci, merge-queue, test262
goal: release-pipeline
related: [2097, 3467, 3468, 3448, 3592, 2562, 1078, 3601]
origin: "PR-queue shepherd verification of the #3601 (#3592 RC2) landing, 2026-07-25. Surfaced only because a deliberate ~5,000-test move was being watched."
---

# #3611 — the standalone high-water mark never re-raises on queue merges

## Problem

On the `#3601` landing (`Test262 Sharded` run **`30152055371`**, merge commit
`31139d0a902c`):

```
success  promote root baseline + cache per-SHA for queue merge (#3467/#3468)
skipped  promote merged report to main baseline          ← carries the #2097 raise
```

The skipped job is the one that runs
`check-standalone-highwater.mjs --update`. When it skips, **the high-water mark
does not re-raise.**

This is not the bot-actor guard: the actor was `github-merge-queue[bot]`, which
is the normal actor for a queue merge. The cause is the **per-SHA-reuse (HIT)
path** interacting with the job's gating —
`needs: [merge-report, mg-artifact-probe]`. That job's own comment asserts:

> Both jobs run+succeed on push and workflow_dispatch, so the implicit
> `success()` over `needs` holds (merge-report green-skips on the HIT path —
> still success).

**That assumption did not hold on this run.** `probe merge_group baseline
artifact` succeeded, the shard matrix green-skipped, and the promote job skipped
along with them rather than running.

## Why this is systemic, not a one-off

Every merge-queue landing takes the per-SHA-reuse path — that is the point of
#3467/#3468. If the promote skips there, **the high-water raise never runs on
merges at all.** The only other thing that advances it is the scheduled
`refresh-baseline.yml`.

**And that workflow is currently `disabled_manually`** (verified 2026-07-25:
`gh api repos/loopdive/js2/actions/workflows/265204741` → `state=disabled_manually`;
a `workflow_dispatch` returns **HTTP 422 "Cannot trigger a 'workflow_dispatch' on
a disabled workflow"**).

So **both** paths that can raise the mark are currently inoperative:

| path                                                     | status                 |
| -------------------------------------------------------- | ---------------------- |
| `promote merged report to main baseline` on queue merges | **skips** (this issue) |
| `refresh-baseline.yml` scheduled 8h cron                 | **disabled_manually**  |

The mark can therefore only fall behind. And the failure is **silent in the
permissive direction**: a floor that is too _low_ never fires, so nothing
complains, ever. It surfaced today only because a deliberate ~5,000-test move was
being watched closely; on an ordinary landing nobody would notice.

### The same disabled workflow also breaks the documented wedge recovery

This is worse than a missing maintenance backstop. The runbook's
disaster-recovery lever for a **wedged #1897** is "dispatch
`refresh-baseline.yml` in EMERGENCY mode" — and that dispatch **cannot execute
at all** while the workflow is disabled. It returns HTTP 422 before doing
anything.

So the failure is not only silent, it is **latent in the recovery path**: it
would be discovered _during an actual queue wedge_, which is exactly when there
is no time to discover it, and when the obvious improvisation — re-enabling a
workflow mid-incident in order to run an unconditional, guard-ignoring promote —
is the most dangerous available version of that action.

It was found here only incidentally, while attempting the _scheduled_ (normal)
mode for an unrelated purpose. Nobody had exercised the emergency path since the
workflow was disabled, because by design nobody exercises it until it is needed.

## Measured impact on the #3601 landing

The #2097 gate reads **`full_summary.host_free_pass`** (full corpus:
standard + annex_b + …), not the official-scope number
(`scripts/check-standalone-highwater.mjs`, line 28), and fails only below
**mark − tolerance** (line 60; `tolerance: 50`).

Independently counted from the authoritative standalone JSONLs
(`loopdive/js2wasm-baselines`, 48,088 rows both sides):

|                                                                |                                                           full-corpus `pass` |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------: |
| pre-landing baseline (live)                                    |                                                                   **27,709** |
| post-landing baseline (re-seeded, `baseline_sha 31139d0a902c`) |                                                                   **22,626** |
| measured removal                                               | **−5,083** (the merge_group's own diff reported −5,088; ±5 run-to-run drift) |

Meanwhile the committed mark stayed at the PR's _estimate_, `pass: 19400`,
`sha: "3592-devacuification-estimate"` — so the effective floor was
`19400 − 50 = 19,350` against a reality of 22,626:

**a ~3,276-test permissive gap.** A subsequent standalone regression of up to
~3,276 tests would have cleared #2097 in silence.

## ⚠️ Stale marks mislead — record this precisely

The high-water is a **raise-only** mark, **not** a pass count. It had lagged
since 2026-07-18, and reasoning from it produced _two independent wrong answers_
during this landing:

- Comparing the stale full-corpus mark (25,453) against the fresh **official**
  number (22,394) gives "−3,059 removed". **Wrong twice over** — stale
  denominator _and_ crossed scopes (full-corpus before vs official-scope after).
- The same-scope, same-freshness answer is **27,709 → 22,626 = −5,083/−5,088**,
  i.e. **18.36 %** of the pass set — which reconciles with the independently
  sampled **18.91 % ± 1.57 %**.

The estimate that drove the PR's ceiling was therefore **accurate as a rate** and
missed only in absolute terms, because it was scaled against the lagging mark.
**Denominator staleness, not measurement error** — a materially different lesson,
and the reason this issue exists.

## User-facing consequence

Until the mark and summary are re-synced, the README / landing page advertises
the **estimate** — `18,400 / 43,106 = 42.7 %` — rather than the measured
`22,394 / 43,106 = 51.9 %`. **A ~9-point understatement of standalone
conformance**, visible to anyone reading the project page.

(PR #3603 closes today's instance by committing the promoted measurement with
provenance. It is the correct _remedy_; it is not a _fix_ for the mechanism —
without this issue the same drift resumes on the next queue merge.)

## Acceptance criteria

1. A merge-queue landing that takes the per-SHA-reuse (HIT) path **runs** the
   high-water raise; the mark advances without manual intervention.
2. The `needs`/`if` gating is corrected so the promote job's own documented
   `success()`-over-`needs` assumption actually holds on the HIT path — or the
   raise is moved to a job that reliably runs on queue merges.
3. A landing whose measured `host_free_pass` exceeds the mark leaves the mark
   **raised**, verified on a real merge.
4. The **silent** failure becomes loud: if the raise is skipped or the mark is
   more than one landing stale, something reports it. A floor that is too low
   must stop being cost-free.
5. Decide the disposition of `refresh-baseline.yml` — it is currently
   `disabled_manually`, removing the only backstop. Either re-enable it (its
   scheduled mode is a normal, guard-respecting promote of already-merged main)
   or record explicitly why the repo runs without that safety net.
6. **Correct the runbook.** The documented disaster-recovery lever for a wedged
   #1897 is "dispatch `refresh-baseline.yml` in EMERGENCY mode" — and that
   dispatch **cannot execute today**, because the workflow is disabled
   (HTTP 422). Whatever is decided in (5), the runbook must not continue to
   name a lever that would fail.
7. The README / landing-page standalone number derives from the promoted
   measurement, never from an in-PR estimate.

## Notes

- Do **not** reach for `refresh-baseline.yml` EMERGENCY mode for this class of
  problem. EMERGENCY does an **unconditional promote that ignores the regression
  guards**; it exists for a _wedged queue_. Using it to correct a number would
  disable the very guards that make the number trustworthy. The scheduled
  (non-force) mode is the guard-respecting path — when the workflow is enabled.
- Equally, hand-writing a mark is only safe when the value is a **promoted
  measurement with provenance** and the change **self-validates** by clearing its
  own #2097 check in its own merge_group (as #3603 does). An invented floor set
  even slightly high false-fails every later PR and wedges the queue.
- Related: #3592/#3601 (the landing that exposed this), #3610 (the 65 real
  callee defects underneath), #3603 (today's remedy).
