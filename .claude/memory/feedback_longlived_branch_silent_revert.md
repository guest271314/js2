---
name: feedback_longlived_branch_silent_revert
description: "A long-lived branch re-merged across many main-advances can SILENTLY revert freshly-landed features (a bad merge resolution drops them); merging re-reverts them → a merge_group regression that PR-level checks + scoped sweeps miss. Verify `git diff origin/main --name-only` shows ONLY intended files before enqueue; re-derive clean if drifted."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

**The hazard (2026-07-10, #2978/#2833):** a long-lived branch, re-merged against
`origin/main` many times over a long session, silently **reverted 12 files** of
main's recently-landed work (#2712 bool-brand, #3031 Proxy-apply, #3121) — a bad
merge conflict resolution dropped those features. The PR's OWN code (#2978) was
fine. Merging the branch would have **re-reverted** the landed features → a net
−4 test262 regression that the PR-level checks AND the dev's own scoped sweep
MISSED; only the `merge_group` full-test262 caught it (auto-parked it).

**Tell-tale symptom:** an auto-park whose regressed files are UNRELATED to the
PR's stated change (e.g. Iterator.prototype / AsyncFromSync failing on an
async-scheduler PR).

**Diagnose + fix + prevent:**
1. Isolate the PR's changes as a PURE diff on current main and reproduce the
   regression WITH the change reverted — if it still fails, it's NOT the change.
2. `git diff origin/main --name-only` listing UNEXPECTED files is NECESSARY but
   NOT SUFFICIENT — a merely-BEHIND branch and a REVERT branch look IDENTICAL by
   name-only (both show the not-yet-merged files as "different"). Disambiguate
   with the merge-base direction test: if `git diff $(git merge-base HEAD main)
   main --name-only` == the "reverted" set, the branch is simply BEHIND those
   commits (a re-merge pulls them in cleanly) — NOT reverting. Only conclude a
   revert when the files were changed on the BRANCH side, not just main-ahead.
   (2026-07-10: this false-positived on #2835 — it was behind #3130, not
   reverting it.)
3. Re-derive clean: restore the reverted files to `origin/main` so the tree ==
   `main + intended files`. Re-validate.
4. **The more re-merges a branch takes (baseline-churn), the higher the
   silent-revert risk.** Another reason to fix the baseline-conflict churn
   (task #24 / [[reference_ci_gate_change_scoped_not_wholetree_absolute]]) and to
   prefer a clean re-derivation over endless hand-re-merges. Shepherds/devs
   re-merging a churned PR should run the name-only diff before enqueue.
5. Compounds with: the `merge_group` catches what scoped sweeps miss
   ([[project_broad_impact_validate_full_ci]]).
