---
name: feedback_same_team_agents_race_same_task_different_conclusions
description: "Spawning two agents with identical/overlapping task-priority lists races them onto the same task — they can reach CONTRADICTORY technical conclusions (opposite root-cause diagnoses) since each allocates its own fresh issue id, so no dup-id gate catches it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

2026-07-02: spawned opus-3 and opus-4 with the same "self-serve from TaskList, priority order: #37, ..." prompt. Both claimed #37 near-simultaneously (TaskUpdate races), and — worse — both `--allocate`d a FRESH issue id each (2981 vs 2982) instead of colliding on one id, so the usual dup-id CI gate never caught it. They reached opposite root-cause diagnoses for the same bug: one concluded "compiler bug, needs a suppressor" (wrong — would have permanently loosened type-checking away from real tsc semantics), the other concluded "test code has a genuine type error, fix the tests" (right, matches real TypeScript `TemplateStringsArray`/`ReadonlyArray` assignability). The wrong PR was still open when the right one merged — caught by reviewing both PRs' file diffs before either landed further.

**Why this evades the usual dup-id/claim-lock protections:** those protections catch id COLLISIONS (two PRs claiming the same number) or branch collisions. They do NOT catch two independently-allocated fresh ids solving "the same underlying problem" with different code — that requires reading both diffs and judging which is technically correct.

**How to apply:** when spawning multiple same-team agents, don't hand them identical top-of-list priorities without a claim-then-verify step — either (a) partition the task list disjointly per agent up front, or (b) accept the race is possible and, after both report, diff their PRs for file/topic overlap even when the issue ids differ; if two PRs solve "the same problem" differently, don't let both merge — read the actual technical content (spec citations, semantics) and pick the correct one, don't average or merge both. See [[project_sprint64_parallel_session_dup_prs]] for the cross-session version of this same root problem.
