---
id: 3584
title: "auto-enqueue.yml can never enqueue a PR that touches .github/workflows/** (silent forever-stall)"
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
related: [2786, 3456, 2547]
origin: "PR-queue shepherd sweep 2026-07-24. PR #3567 sat green+CLEAN for 6h45m with zero enqueue attempts; diagnosed as an App-token permission hole, rescued by a one-shot PAT enqueue."
---

# #3584 — `auto-enqueue.yml` is structurally blind to PRs touching `.github/workflows/**`

## Problem

Any PR whose diff includes a file under `.github/workflows/**` is **permanently
un-auto-enqueueable**. This is not "slow" or "picked up on the next cron" — it is a
**silent forever-stall**. The PR stays green, `CLEAN`, unlabelled, comment-free, and
simply never enters the merge queue. Nothing in the pipeline surfaces it: there is no
`hold` label, no bot comment, no failing check. It just sits.

Since #2786 made the server-side workflow the _single_ enqueuer and devs explicitly
stand down after CI goes green, there is no agent left watching. The only thing that
recovers such a PR is a human or the PR-queue shepherd noticing it in a manual sweep.

## Evidence (PR #3567, 2026-07-24)

PR #3567 (`fix(#3456): remove queue-unstick automated re-enqueue loop`) touched:

```
.github/workflows/approve-fork-runs.yml
.github/workflows/auto-park-merge-group-failures.yml
.github/workflows/queue-unstick.yml
docs/ci-policy.md
plan/issues/3456-ci-queue-unstick-requeue-churn.md
scripts/approve-fork-runs.mjs
scripts/auto-park-merge-group-failure.mjs
scripts/unstick-merge-queue.mjs
```

- All 7 required checks `SUCCESS`; not a draft; no `hold`; no reviews requested.
- Open and green from **15:06 UTC**; still un-enqueued at **21:55 UTC** (6h45m).
- `auto-enqueue.yml` ran ~20 times in that window. **Every single run** logged:
  ```
  - #3567 skip (BLOCKED)
  ```
  (e.g. runs `30126231181` @21:01, `30129070114` @21:50.)
- Meanwhile, querying with a **user PAT** at the same moment:
  ```
  $ gh api repos/loopdive/js2/pulls/3567 --jq '.mergeable_state'
  clean
  $ gh pr view 3567 --json mergeStateStatus   # GraphQL, user PAT
  CLEAN
  ```
- The PR timeline had **zero** events and **zero** comments — it was never enqueued,
  never ejected, never parked. It had simply never been attempted.

**The divergence is the whole tell:** `mergeStateStatus` / `mergeable_state` is
computed **relative to the querying token's permissions**. `BLOCKED` does not mean
"this PR is not ready"; it means "_you_ cannot merge this PR right now."

## Mechanism

`auto-enqueue.yml` mints a scoped GitHub App installation token
(`actions/create-github-app-token@v3`) and hands it to
`scripts/enqueue-green-prs.mjs` as `GH_TOKEN`. That App installation does **not**
hold the `workflows` permission.

GitHub refuses to let a token without `workflows: write` land changes to files under
`.github/workflows/**`. That refusal is surfaced ahead of time as
`mergeStateStatus: BLOCKED` for that token. `enqueue-green-prs.mjs` treats any
non-`CLEAN` state as "not my problem yet" and skips — correctly, for every other
cause of `BLOCKED` (checks still running, review required, drift), but fatally here,
because for this cause the state **never changes**.

The ~30-min cron backstop shares the same token, so it re-derives the same `BLOCKED`
and is equally incapable of recovery. There is no self-healing path.

**Blast radius is not niche.** CI/infra work is exactly the category of PR that
touches `.github/workflows/**`, and it is also the category whose stalling degrades
the pipeline that everything else depends on — including, ironically, #3567 itself,
which was a fix to the merge queue.

## Options (weigh; do not implement blind)

### A. Grant the App `workflows: write`

- **Pro**: one-line permission change, fixes the class outright, keeps a single
  enqueuer and a single code path.
- **Con**: materially widens the blast radius of a compromised or confused-deputy App
  token — it would gain the ability to land arbitrary CI workflow changes, which is
  effectively arbitrary code execution on runners with repo secrets. The App is
  currently invoked from `workflow_run`, a trigger that has historically been a soft
  spot for privilege confusion. **This is the option that needs a real security
  decision, not just a config edit.**

### B. PAT fallback in `scripts/enqueue-green-prs.mjs`

- Detect a workflow-touching PR (`gh pr view <n> --json files`, any path matching
  `.github/workflows/`) and, only for those, re-query and enqueue with a stored PAT
  secret.
- **Pro**: keeps the App token narrow for the 95% case; the elevated credential is
  used on a small, explicitly-detected path.
- **Con**: introduces a second credential and a second code path; the PAT is a
  long-lived user credential in repo secrets (rotation burden), and the detection
  itself becomes a security boundary that must not be spoofable.

### C. Minimum viable: make it loud

- When a PR is skipped as `BLOCKED` **and** has all required checks green **and** has
  been green for more than ~15 minutes, log a distinct warning naming the PR, and
  (optionally) apply a `needs-manual-enqueue` label.
- **Pro**: does not touch the permission model at all; converts a silent
  forever-stall into a visible one, which is the actual harm here. Cheap, safe,
  independently useful even if A or B lands later.
- **Con**: still requires a human/shepherd to act; does not fix the class.

**Suggested shape**: land C unconditionally as a safety net (it is valuable
regardless), then decide A vs B as a deliberate security call.

## Acceptance criteria

1. A PR that touches `.github/workflows/**` and is otherwise green either (a) gets
   auto-enqueued, or (b) is surfaced loudly within ~15 min — not silently skipped.
2. `scripts/enqueue-green-prs.mjs` distinguishes _transient_ `BLOCKED` (checks pending
   / drift) from _permanent_ `BLOCKED` (token cannot merge these paths) in its log
   output, rather than emitting the same `skip (BLOCKED)` line for both.
3. If option A is chosen, the permission widening is recorded in `docs/ci-policy.md`
   with the security rationale.
4. Regression check: re-run the scenario against a scratch PR touching a workflow file
   and confirm it does not strand.

## Notes

- Workaround in the meantime (used to rescue #3567): the PR-queue shepherd enqueues
  once with a user PAT via the GraphQL `enqueuePullRequest` mutation. **Once** — never
  in a loop (see #3456 / `project_merge_queue_requeue_cancels_run`).
- Related: #2786 (server-side auto-enqueue became the single enqueuer, which is what
  turned this from "a dev would have noticed" into a silent stall), #3456 (re-enqueue
  churn — the reason a loop is not an acceptable mitigation), #2547 (auto-park, the
  other merge-queue safety net).
