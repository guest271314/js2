---
id: 3597
title: "check:issue-ids should detect collisions against OPEN PRs, not only main — the gap that silently parks PRs"
status: ready
sprint: current
created: 2026-07-24
updated: 2026-07-24
priority: high
horizon: s
feasibility: medium
task_type: ci
area: ci, merge-queue
goal: release-pipeline
related: [2531, 2547, 1616]
origin: "PR-queue shepherd, 2026-07-24. Two duplicate-id collisions in one hour; the second was invisible at PR level and only surfaced as a merge_group auto-park."
---

# #3597 — the issue-id gate checks `main` but not open PRs, so collisions surface as merge-queue parks

## Problem

There is an **asymmetry** between the two halves of the id-collision defence:

| component                                | scans                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `claim-issue.mjs --allocate`             | `origin/main` ∪ **every open PR's added issue files** ∪ the `issue-assignments` ref |
| `check:issue-ids:against-main` (CI gate) | `main` **only**                                                                     |

`--allocate` already scans open PRs, precisely because two branches can each add
the same id while **neither file is on `main` yet**. The CI gate does not. So the
gate cannot see the very collision the allocator was built to prevent.

Consequence: when two open PRs claim the same id, **both are green at PR level**.
The collision only materialises once the first one merges. Depending on timing:

- if the loser's checks re-run after the winner lands → the gate fires loudly at
  PR level (the good case);
- if the loser reaches the merge queue first → the duplicate is caught only by
  the `--check` duplicate-id gate in the `merge_group`, which **auto-parks** the
  PR with a `hold` (#2547). A park is far more expensive than a red check: it
  needs a human/shepherd to diagnose, and a parked PR is skipped by
  `auto-enqueue`, so it strands until someone intervenes.

## Evidence — both collisions, 2026-07-24, within one hour

**Collision A — id 3584** (`plan/issues/3584-*`): PR #3577 vs PR #3579. Caught at
PR level, but only because #3577 merged first. `--allocate` had reserved the id
at `22:05:41Z`; #3579 was opened ~29 min later.

**Collision B — id 3589** (`plan/issues/3589-*`): PR #3582 vs PR #3581. This one
was **invisible at PR level** — `check:issue-ids:against-main` was green on #3581
because #3582 had not merged when its checks ran. It surfaced only in the
`merge_group`:

```
Issue integrity + link gate (#1616)
--check FAILED: 1 duplicate IDs
```

…which auto-parked #3581 with a `hold`. Reserved at `22:30:26Z`; #3581 opened
~5 min later.

## Root cause of the collisions themselves (why this will recur)

`origin/issue-assignments` held **only one** reservation record for each of 3584
and 3589 — in both cases the record belonging to the PR that reserved via
`claim-issue.mjs --allocate`. The colliding branches left no record at all, i.e.
that lane is **not going through `--allocate`**.

That is the important framing: **the fix must not depend on every lane
cooperating with the reservation protocol.** Reservation is advisory; the gate is
the enforcement point. Making the gate see open PRs works regardless of how the
id was chosen.

## Proposed fix

Extend the PR-level gate to compare a branch's **added** issue files against the
union of `main` **and every other open PR's added issue files** — reusing the
open-PR scan `claim-issue.mjs --allocate` already implements, rather than writing
a second one.

Design points:

- **Added files only.** A PR that _modifies_ an existing `plan/issues/<id>-*.md`
  is not a collision. A naive id-only comparison flags all of those as false
  positives (confirmed empirically — a first pass at this flagged five PRs that
  were all ordinary modifications).
- **Compare full filenames, not just ids** — same id + same filename ⇒
  modification; same id + different filename ⇒ real collision.
- **Report both sides**, so whoever reads the red check knows which PR they raced
  and can apply the tie-break without digging.
- **Tie-break, to state in the failure message**: the merged/queued PR keeps the
  id; the other renumbers via `claim-issue.mjs --allocate`. Reservation timestamps
  on `origin/issue-assignments` break ties when neither is queued yet.
- **Fail soft on API unavailability.** The open-PR scan needs network; if it
  cannot run, warn rather than blocking every PR on a GitHub outage. The existing
  against-main check stays hard.

## Acceptance criteria

1. Two open PRs adding the same issue id ⇒ **both** get a red `quality` check at
   PR level, before either reaches the merge queue.
2. A PR that merely modifies an existing issue file is **not** flagged.
3. The failure message names the colliding PR and states the renumber command.
4. The `merge_group` `--check` duplicate-id gate remains as the backstop (this
   change should make it near-unreachable in practice, not replace it).
5. Works regardless of whether the colliding branch used `--allocate`.

## Interim mitigation

A pre-emptive sweep script is in use by the PR-queue shepherd — it walks every
open PR's added issue files and compares against `main`, distinguishing
modifications from real collisions. Cheap to run once per sweep loop until this
gate lands.
