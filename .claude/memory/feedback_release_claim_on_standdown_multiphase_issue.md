---
name: feedback_release_claim_on_standdown_multiphase_issue
description: A dev that completes one PR for a multi-phase issue must RELEASE its git-backed claim on stand-down, else the stale claim blocks the next phase's dispatch
metadata:
  type: feedback
---

When a dev claims an issue via `claim-issue.mjs <id> <assignee>` (git-backed
claim on the `issue-assignments` ref) but the issue spans **multiple
phases/PRs** and stays `status: in-progress` after the dev's PR merges, the dev
MUST **release the claim on stand-down**: `node scripts/claim-issue.mjs --release
<id> [<assignee>]`. Completing the *task* (merging one PR) does NOT release the
*issue* claim — they're separate. A stale claim makes the next-phase dispatch
hit `EXIT=3 "already claimed by <prev-agent>"`, and a well-behaved successor
agent will (correctly) refuse to `--force`-steal and **stand down** — wasting the
dispatch.

**Why:** observed on #2632 (2026-06-24) — the substrate dev claimed #2632, landed
the substrate PR #2007, stood down without releasing; the follow-up senior-dev
for the faithful `process.stdin` Readable hit exit 3 and stood down rather than
steal. The lead had to `--release --force` the stale claim and re-dispatch.

**How to apply:**
- Dev: on stand-down where the issue continues past your slice/PR, run
  `claim-issue.mjs --release <id>` (or `complete` only if the WHOLE issue is
  done). Releasing ≠ abandoning — it just frees the next phase.
- Lead: a successor agent that stands down citing "claimed by <agent> (exit 3)"
  for an agent that has **already merged + gone** is a **stale claim**, not a
  real conflict. Verify the prior holder is done (PR merged), then
  `claim-issue.mjs --release <id> --force` and re-dispatch.
- **Gotcha:** `claim-issue.mjs <id> <assignee>` is a WRITE even when you mean to
  "just check" — there is no read-only verify-by-claim, and `--dry-run` is NOT
  honored in claim mode (only in `--allocate`). To inspect without claiming, read
  `origin/issue-assignments:<id>.json` directly (`status`/`assignee`). A probe
  claim must be released afterward or it leaks a `ttraenkler/probe`-style holder.

See [[feedback_slice_claim_collision_check_assignments_log]] and
[[feedback_no_shared_worktree_assignment]].
