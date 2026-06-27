---
name: reference_hold_label_does_not_dequeue_inflight_merge_queue_pr
description: "A `hold` label only blocks the auto-enqueue backstop's FUTURE decisions; it does NOT remove a PR already sitting in the merge queue. To truly stop an outward-facing / do-not-merge PR, dequeue it (or close/convert-to-draft) — labeling alone is too late once the backstop has enqueued it."
metadata:
  node_type: memory
  type: reference
  originSessionId: 8c1a4e31-7549-4d26-8712-eeb6350092ec
---

**Near-miss (Sprint 67, PR #2183 `chore(release): v0.57.0 — first npm publish`).** A release/npm-publish PR appeared CLEAN. The user chose "Hold it" and I added a `hold` label to stop the auto-enqueue backstop. **#2183 merged anyway** (09:55) — because the `auto-enqueue.yml` backstop had ALREADY enqueued it into the merge queue in the window between its creation and my label. A `hold` label only changes what the backstop enqueues *next*; it does **not** dequeue a PR already in the merge queue, and the merge queue does not re-read labels to eject an in-flight entry.

**Rule:** to actually stop an outward-facing / do-not-merge PR, the label is NOT sufficient once it may be queued. You must one of:
1. **Dequeue it** — `gh api graphql` `dequeuePullRequest` mutation (user PAT), OR
2. **Close it** / convert to **draft** (drafts are never enqueued), AND
3. Add the `hold` label so the backstop won't re-add it.
**Always check the PR's `mergeQueueEntry.state` when you decide to hold** — if it's non-null (QUEUED/AWAITING_CHECKS), labeling alone is too late; dequeue/close it.

**Saving grace this time:** the `publish-npm.yml` job FAILED (the `@loopdive/js2` + `js2wasm` proxy publish step errored), so nothing reached npm (`npm view @loopdive/js2` → 404). The user's intent held by luck (publish failure), not by the hold. The only durable effect was the committed v0.57.0 version bump on main — reversible via a revert PR. The publish workflow triggers on push-to-main when the version changes, so a bumped-but-unpublished version leaves the publish "armed" for any future successful run.

See [[feedback_explicit_main_push]] (outward-facing actions need explicit per-time consent) and the merge-queue requeue hazard in [[project_merge_queue_requeue_cancels_run]].
