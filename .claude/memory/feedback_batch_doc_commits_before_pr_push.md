---
name: feedback_batch_doc_commits_before_pr_push
description: "Batch plan/doc commits into the first PR push; a 2nd doc-only commit re-triggers the full CI matrix on the new HEAD"
metadata:
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

When opening a PR, commit any companion plan/issue/architect-spec docs in the
SAME push as the code — don't push the code, open the PR, then add a doc commit
and re-push.

**Why:** every push to the PR branch re-triggers the full required-checks matrix
(test262 sharded js-host + standalone, equivalence shards, quality) on the new
HEAD, even for a docs-only commit. A late doc commit therefore burns a whole
extra CI run (~57 standalone + 57 js-host shards here) and resets the
self-merge/enqueue clock while GitHub re-syncs the fork→PR HEAD (which itself
lags minutes on cross-fork PRs). Observed on PR #1678 (#38 DataView windowing):
pushed code → CI nearly green → added the #46 architect spec (`plan/issues/2192`)
as a 2nd commit → re-push wiped the green run.

**How to apply:** stage code + docs together, commit, push ONCE, then open the
PR. If a doc genuinely must follow (e.g. it references the merged PR number),
prefer a separate follow-up PR over re-pushing the in-flight one. See
[[feedback_no_duplicate_issue_dispatch]] for the related "validate before
pushing" discipline.
