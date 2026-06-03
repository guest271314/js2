---
name: feedback_wedged_merge_queue_reset
description: "A wedged GitHub merge queue (PRs stuck AWAITING_CHECKS, no merge_group runs) needs a ~10-MINUTE disable window to reset — a quick disable/re-enable toggle does NOT work"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

**Symptom of a wedged GitHub merge queue:** PRs enqueue but sit forever in `AWAITING_CHECKS`, and **zero `merge_group` workflow runs fire** — while ordinary PR CI (`pull_request`/`push` events) keeps working fine. The queue stopped forming merge groups at a specific timestamp and won't restart on its own, even with the queue empty.

**Diagnosis (rule out config first):** it's GitHub-side queue-processor state, NOT your config, when: the ruleset is unchanged, the required-check **names** match what merge_group actually reported on the last good run (`gh api /repos/OWNER/REPO/commits/SHA/check-runs`), and `githubstatus.com` shows no incident. Confirm "no merge_group runs since T" via `gh api '/repos/OWNER/REPO/actions/runs?event=merge_group&per_page=1'`. Branch protection may be a **ruleset** (`gh api /repos/OWNER/REPO/rulesets`), not classic protection.

**Why:** the auto-enqueue/dispatch is server-side; a stuck queue keeps accepting enqueues but never builds the temporary `gh-readonly-queue/main/pr-N-…` ref, so the merge_group event never fires.

**Fix — the disable WINDOW matters (the key learning):**
- A **quick** disable→re-enable toggle of the merge_queue rule does **NOT** clear it (verified 2026-05-30: toggled in seconds, still wedged; #980 sat AWAITING_CHECKS with no dispatch and had to be admin-merged).
- A **~10-minute disable window DID fix it** (verified same day): disable the merge_queue rule, leave it OFF ~10 min so GitHub fully drains/tears down the queue state, then re-enable the **exact original** ruleset. The next enqueued PR (#981) immediately got a merge_group dispatch and merged through the queue normally.

**How to apply (API, reversible):**
1. `gh api /repos/OWNER/REPO/rulesets/RID > backup.json` (back up verbatim).
2. Build a PUT payload of `{name,target,enforcement,conditions,bypass_actors,rules}` with the `merge_queue` rule **removed**; `gh api --method PUT /repos/OWNER/REPO/rulesets/RID --input disable.json` → verify `[.rules[].type]` no longer lists merge_queue.
3. **Wait ~10 minutes** (background `sleep 600`), NOT seconds.
4. PUT the **original** rules back; verify both rules restored with identical params (compare order-insensitively — GitHub may reorder rules, which is benign).
5. Enqueue a green PR via GraphQL `enqueuePullRequest` and watch for a `merge_group` run on its `pr-N` ref to confirm.

**Interim while wedged:** dequeue (`dequeuePullRequest`) + `GATE_BYPASS=1 gh pr merge N --merge --admin` on full-CI-green PRs only — but that's a bypass; the 10-min reset is the actual fix. Also clean up any orphaned `gh-readonly-queue/main/pr-*` refs whose PRs already merged (`gh api --method DELETE /repos/OWNER/REPO/git/refs/heads/gh-readonly-queue/...`). Relates to [[feedback_draft_pr_until_final]].
