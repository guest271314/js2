---
name: feedback_dev_ci_watchers_strand_green_prs
description: "Dev/senior-dev background CI watchers don't reliably enqueue on agent terminate — green PRs strand; lead must sweep every loop"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

A dev/senior-dev's "backgrounded CI watcher will one-shot enqueue when green"
is NOT reliable: when the agent parks/terminates before its watcher fires, the
green CLEAN PR **strands un-enqueued** with an empty merge queue. Confirmed
twice — #2225 and #2247 (user flagged #2247: "why is pr not enqueued?").

**Why:** The watcher is a background child of the agent; agent termination
(stand-down, turn completion) can leave the enqueue uncompleted. The ~30-min
`auto-enqueue` cron is the backstop but too sparse to catch it promptly.

**How to apply:** Don't trust the per-agent watcher. EVERY lead loop, sweep
`gh pr list -R loopdive/js2wasm --state open` and one-shot enqueue (GraphQL
`enqueuePullRequest`, user PAT) every CLEAN, non-`hold`, non-draft PR not
already in the merge queue. Treat the sweep as the PRIMARY enqueuer, not a
fallback. See [[feedback_lead_shepherds_prs]], [[feedback_dedicated_pr_shepherd]].
