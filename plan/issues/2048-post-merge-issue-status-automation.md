---
id: 2048
title: "process: nothing executes the 'merged PR ⇒ status: done' rule — stale in-review issues caused 17 doc-churn PRs and redispatch loops in sprint 61"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-07-03
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ci, process
language_feature: n/a
goal: process
related: [1602, 1603, 1606]
origin: "2026-06-10 sprint-61 merged-PR review: of 24 merged PRs, only ~7 contained code; the rest were issue-file metadata commits from codex agents re-validating issues that were already merged but still read `status: in-review` — including a GH006 merge-queue push-rejection loop that wrote 842 lines into one issue file (#1909)."
---

# #2048 — Automate the merged-PR ⇒ `status: done` flip

## Problem

CLAUDE.md's lifecycle rule ("a merged PR ⇒ `done`; never leave a merged
issue at `in-review`") is enforced by nobody:

- The self-merge path assumes the **impl PR itself** carries
  `status: done` — but symphony/codex-driven issues set `in-review` and
  delegate the flip to a "PR-status poller" that does not exist (or never
  ran: #1904/#1905/#1907/#1909/#1910/#1832/#1886 all sat at `in-review`
  for 3+ days after their final merges).
- `scripts/reconcile-tasklist.mjs` reconciles the **TaskList** from issue
  frontmatter — it inherits the staleness, it cannot cure it.

Measured cost in sprint 61 (2026-06-05..07): **17 of 24 merged PRs were
zero-code issue-metadata commits** from agents re-validating never-closed
issues — including 5 successive doc-PRs on #1905, ~25 near-duplicate
"queue push blocker" sections on #1909 (842 lines, a GH006 push-rejection
→ refresh → re-push loop against the merge queue), and repeated
dequeue/re-enqueue of the agents' own PRs. Each loop burns CI shards,
merge-queue slots, and reviewer attention.

## Suggested fix (layered; 1 is the load-bearing piece)

1. **Post-merge workflow flips the frontmatter.** Extend
   `.github/workflows/auto-enqueue.yml` (or a new small workflow on
   `push: main`): for each merge commit whose branch name matches
   `symphony/<id>` / `issue-<id>-*`, if `plan/issues/<id>-*.md` has
   `status: in-review` (or `in-progress`) **and no other open PR
   references the issue**, commit `status: done` + `completed: <date>`
   directly to main (`[skip ci]`, same trust level as the
   `promote-baseline` auto-commit).
2. **Agent-side gate:** the codex/symphony redispatch prompt must check
   `gh pr view <pr> --json state` first — if MERGED, stop and (at most)
   flip the issue file once; never re-open validation passes or push
   metadata to a branch that is in/through the merge queue.
3. **Reconciler check:** extend `scripts/reconcile-tasklist.mjs` to also
   report (not auto-fix) `in-review` issues whose `pr:` is merged, so the
   tech-lead session-start hook surfaces any that slip past (1).

## Acceptance criteria

- An issue left at `in-review` whose PR merges is flipped to `done` within
  one workflow run, with `completed:` set — verified by a dry-run on a
  fixture branch name.
- Reconciler reports zero stale `in-review` issues on main after the
  sprint-61 backfill (done manually 2026-06-10).
- No redispatch loop in the following sprint produces >1 post-merge
  metadata PR per issue.

## Partial resolution — layer 3 (2026-07-03)

**Layer 3 (reconciler surfacing) landed.** `scripts/reconcile-tasklist.mjs`'s
merged-PR cross-check (#2147) previously flagged only `ready`/`in-progress`
issues cited by a merged code PR — `in-review` was deliberately excluded as
"not a wrong-claim risk." But that is exactly the stale-status class #2048 is
about: an `in-review` issue whose fix has merged but whose frontmatter never got
flipped to `done`. Added `in-review` to `AT_RISK_ISSUE_STATUSES`, so the
reconciler (already a SessionStart hook, `--quiet`) now surfaces these too, with
guidance that they are the "merged PR ⇒ done" flip that never ran. Report-only
— no frontmatter is written — so zero blast radius. This satisfies the
**"Reconciler reports zero stale `in-review` issues"** acceptance bullet (the
reconciler now _detects_ them so the lead/PO can act; it reports 0 only once the
backfill is applied).

**Still open (this issue stays `ready`):**

- **Layer 1 (load-bearing)** — a `push: main` workflow that auto-commits
  `status: done` + `completed:` for a merged `issue-<id>-*` / `symphony/<id>`
  branch whose issue is still `in-review`/`in-progress` and has no other open
  PR. Deferred here: it writes to `main` and can only be validated on a real
  merge event (not on-demand), so it wants its own careful PR + a fixture
  dry-run. It is the piece that actually _cures_ the churn.
- **Layer 2** — the codex/symphony redispatch prompt gating on `gh pr view
<pr> --json state` before re-validating a merged issue (a prompt/process
  change, not code in this repo).
