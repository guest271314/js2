---
name: reference-gh-remove-label-rest-not-pr-edit
description: gh pr edit --remove-label/--add-label silently no-ops (projectCards deprecation aborts the mutation); use the REST API to change PR/issue labels
metadata: 
  node_type: memory
  type: reference
  originSessionId: fab8c15e-42ba-4dae-b2f8-dc6dcc1155b9
---

`gh pr edit <N> --remove-label <L>` (and `--add-label`) can **silently no-op**:
it returns `rc=0` but prints a GraphQL warning
`Projects (classic) is being deprecated ... repository.pullRequest.projectCards`
and the label is **unchanged**. Cause: gh's `updatePullRequest` GraphQL mutation
still selects the deprecated `projectCards` field, which now errors and aborts
the whole mutation — so the label edit never applies. The command looks like it
succeeded.

**Workaround — use the REST API directly** (bypasses the GraphQL/projectCards path):

```bash
# remove a label
gh api -X DELETE repos/<owner>/<repo>/issues/<N>/labels/<label>
# add labels
gh api repos/<owner>/<repo>/issues/<N>/labels -f "labels[]=<label>"
```

The DELETE returns the remaining labels array, so you can confirm in one call.
Works for both PRs and issues (PRs are issues for the labels endpoint).

Verified 2026-06-20 removing `hold` from `loopdive/js2` PR #1787 — `gh pr edit`
reported success but left `["hold"]`; the REST DELETE removed it and it stayed
removed (no automation was re-adding it; the gh bug was the whole story). Relevant
when un-parking a held PR before enqueue.
