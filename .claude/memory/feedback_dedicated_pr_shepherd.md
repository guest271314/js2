---
name: feedback-dedicated-pr-shepherd
description: "During an ACTIVE sprint, always spawn a dedicated standing PR-queue shepherd teammate scoped to the team's OWN PRs (reversal of the sprint-64 lead-does-it-himself rule)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

**CURRENT RULE (stakeholder, 2026-06-28):** when a sprint is on, **always spawn a
dedicated standing PR-queue shepherd** teammate for the PRs your team opened. Spawn it
as part of bringing a sprint up, not on-demand after PRs strand.

This **reverses** the earlier sprint-64 (2026-06-19) correction that said shepherding was
the lead's own job and a dedicated shepherd was over-delegation. The stakeholder changed
their mind on 2026-06-28 after seeing green PRs (#2235, #2236) strand un-enqueued waiting
on the `auto-enqueue` backstop cron — exactly the gap a standing shepherd closes.

**Scope: the team's OWN PRs only** — PRs this session's agents authored. Do NOT shepherd
PRs from other parallel driver sessions (they shepherd their own); the merge queue itself
owns merge strategy.

**Shepherd does (every loop):**
- Sweep `gh pr list -R loopdive/js2wasm --state open`.
- One-shot enqueue every CLEAN, non-`hold`, non-draft PR not already in the queue —
  GraphQL `enqueuePullRequest` with the **user PAT**:
  `PRID=$(gh pr view N --json id -q .id); gh api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}' -f id="$PRID"`.
  NEVER `gh pr merge --auto` (no-ops on already-green CLEAN PRs); NEVER `GITHUB_TOKEN`
  (suppresses the `merge_group` event). **NEVER re-enqueue** (re-add cancels the in-flight
  `merge_group` run — see [[project_merge_queue_requeue_cancels_run]]).
- Monitor `merge_group` results; handle parks/ejections per the auto-park rules.
- Reconcile merged PRs → TaskList `completed` + issue `status: done`.

**Escalate to lead (don't self-handle):** regressions >10, single bucket >50, a genuine
merged-baseline regression behind a bot park-hold, or a semantic `src/` conflict — create
a `[CONFLICT]`/`[CI-FIX]` task for a dev (senior-dev for src conflicts) with full PR context.

**Spawn form:** `Agent` subagent_type `developer`, `isolation: "worktree"`,
`run_in_background: true`, name `pr-shepherd`. It's a long-running teammate — keep it alive
for the sprint; `shutdown_request` when the sprint ends.

**Backstop (automation, still valid):** `.github/workflows/auto-enqueue.yml`
(`scripts/enqueue-green-prs.mjs`, cron + on each CI completion) remains the BACKSTOP for
strays. The shepherd is the PRIMARY; the cron only catches what the shepherd misses.
Related: [[feedback_lead_shepherds_prs]], [[feedback_reduce_notification_noise]].
