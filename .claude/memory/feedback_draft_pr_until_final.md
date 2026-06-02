---
name: feedback_draft_pr_until_final
description: "Keep a PR DRAFT while iterating / when a follow-up push may be needed; mark Ready only when final — drafts are never auto-enqueued, preventing the stale-SHA merge race"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

Open/keep a PR as **DRAFT** while still iterating, or whenever a follow-up push might be needed. Mark **"Ready for review" only when the PR is final** and you want it merged.

**Why:** the auto-enqueue backstop merges a PR the moment its checks go green — but "green" fires mid-work, not at "done". A green non-draft PR gets queued, which LOCKS the branch (you can't push to a queued PR), so later commits can't land and the queue merges the stale half. This stranded CPR-2 on 2026-05-30 (#963 merged at the CPR-1-only SHA; for-of+param got left behind). Drafts are never auto-enqueued, so draft-until-final turns the "green" check-state signal into an explicit author "ready" decision — the real fix.

**How to apply:** (1) open cross-slice / multi-commit / still-iterating PRs as draft; (2) mark ready only when the diff is final and merged-with-current-main; (3) for cross-dependent PRs (one must land before another updates), keep the dependent draft until its prerequisite lands. Auto-enqueue (`.github/workflows/auto-enqueue.yml`, `scripts/enqueue-green-prs.mjs`) is **RE-ENABLED** (2026-05-30, on user instruction) — **draft-until-final is the guardrail that makes it safe**: only non-draft mergeable PRs are swept, so keeping a PR draft until its diff is final keeps the "green ⇒ enqueue ⇒ branch locked" race from ever triggering mid-iteration. Drafts and PRs labelled `hold`/`do-not-merge`/`wip` are never auto-enqueued. If the merge_group queue stalls (it did intermittently this session), the tech-lead admin-merges the final PR directly (dequeue via GraphQL `dequeuePullRequest`, then `GATE_BYPASS=1 gh pr merge --merge --admin`) — but that's the exception, not the default. Relates to [[feedback_serialize_cherry_picks]].
