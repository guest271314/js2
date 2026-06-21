---
name: feedback-dedicated-pr-shepherd
description: "PR-queue shepherding is the team-LEAD's own job (lightweight: enqueue green, simple drift, reconcile); reassign only lengthy conflict-resolution/fixes to a dev — do NOT spawn a dedicated shepherd agent"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

**CORRECTED by the stakeholder (sprint 64, 2026-06-19):** shepherding the team's
open PRs is the **team-lead's own job** — NOT a dedicated standing shepherd agent.
The lead does the lightweight, continuous parts itself; only **lengthy conflict
resolution or a real fix gets reassigned to a dev**. (The earlier guidance to staff
a permanent PR-shepherd teammate was over-delegation; the user shut that down — I had
spawned a `pr-shepherd` agent and was told to take the sweep back.)

**Scope: the team's OWN PRs only** — i.e. PRs this session's agents authored. Do NOT
shepherd PRs driven by other parallel driver sessions (they shepherd their own); and
the merge queue itself owns the strategy.

**Lead does directly (lightweight, every loop):**
- Enqueue stranded CLEAN/green-but-unqueued PRs — GraphQL `enqueuePullRequest`
  (`PRID=$(gh pr view N --json id -q .id); gh api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}' -f id="$PRID"`).
  NEVER `gh pr merge --auto` (no-ops on already-green CLEAN PRs).
- Simple drift: a trivial `git merge origin/main` with only doc/test/baseline conflicts.
- Reconcile merged PRs → TaskList `completed` + issue `status: done`.
- Active devs shepherd their OWN in-flight PRs (BLOCKED/UNSTABLE on their branches) — don't step on them.

**Reassign to a dev (create a task, set owner):** any PR needing
- a **semantic src/ conflict** resolution (e.g. a hot file like property-access.ts),
- a real CI-failure fix / regression,
- a verify-then-rescue-or-close judgement (stale PR possibly superseded).
Give the dev a verify-before step (does it still flip / is it superseded → close) before resolving.

**Backstop (automation, still valid):** `.github/workflows/auto-enqueue.yml`
(`scripts/enqueue-green-prs.mjs`, every 10 min + on each CI completion) auto-enqueues
any open green mergeable non-draft PR. So green PRs self-heal within ~10 min even if the
lead misses a sweep; the lead's manual enqueue just makes it immediate. The backstop does
NOT touch DIRTY/BLOCKED (those need the dev/lead). Related: [[feedback_no_ci_wait]],
[[feedback_reduce_notification_noise]].
