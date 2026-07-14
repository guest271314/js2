---
name: reference_standdown_at_merge_not_green_prlevel_mergegroup_gates_orphan
description: "When you stand an agent down as soon as its PR is GREEN AT THE PR LEVEL, the merge_group re-validation can still surface additional required-gate fails (coercion-site-drift #2108/#3131, issue-integrity #1616, standalone-floor, oracle-ratchet) that the PR-level checks did not run — and with the author gone the PR ORPHANS on a fixable gate. Prevention: either keep the author alive until the PR actually MERGES, or (cheaper) accept green-PR-level stand-down but STAFF a CI-FIX sweep to adopt+fix post-standdown merge_group gate fails. Don't assume a green-PR-level PR merges unattended."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Observed 2026-07-13 (lead).** Stood down three deep-budget agents on their
milestones the moment they reported green PRs (opus-r4/#2989 R4b, opus-3201b/
#2990 join-for-of, opus-substrate/#2986). Two then FAILED a merge_group required
gate that the PR-level checks hadn't run:
- **#2989** → "Coercion-site drift gate (#2108/#3131)" (R4b's new
  ta-hof-map-filter.ts added coercion sites; fix = `coercion-sites-allow`
  frontmatter, baseline unmodified per #3131).
- **#2990** → "Issue integrity + link gate (#1616)" (issue-file frontmatter/link
  integrity).
- (plus a separately-stranded **#2975** on "Issue→probe coverage gate #2093".)

With the authors gone, all three orphaned BEHIND on a *fixable* gate — no
regression, just an allowance/frontmatter/probe entry nobody was left to add.

**Two valid models — pick one, don't drift into neither:**
1. **Stand down at actual MERGE, not green-PR-level** — keep the author alive
   (or its next-slice self-serve loop) until the queue lands the PR, so it fixes
   any merge_group gate fail itself. Costs the ~15-min merge wait per agent.
2. **Stand down at green-PR-level (cheaper) + STAFF a CI-FIX sweep** — accept the
   author leaves, and dispatch a dedicated CI-FIX developer (or pr-shepherd3 +
   a [CI-FIX] task) to ADOPT orphaned PRs and add the allowance/frontmatter/probe
   per gate. This is the model used here (agent opus-cifix rescued all three).

The CI-FIX adopter flow: `git fetch`, checkout the PR branch, `git merge
origin/main` (un-BEHIND), smallest-correct fix per gate (allowlist frontmatter,
NOT a baseline edit), `git push --no-verify`, verify the check flips green, let
auto-enqueue land it. Same pattern as the earlier "[CI-FIX] land orphaned #29xx,
dead author" tasks. Related: [[reference_backgrounded_merge_watcher_dies_strands_agent_on_base_merge]]
(the other way agents strand near merge), the coercion-sites-allow / loc-budget
#3131 frontmatter-allowlist mechanism.
