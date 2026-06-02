---
name: feedback_cla_gate
description: "Don't merge external-contributor PRs without an affirmative CLA acceptance recorded — the cla-check is a placeholder stub"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

Do NOT merge external-contributor PRs until an **affirmative CLA acceptance** is recorded for that contributor.

**Why / current state:** `.github/workflows/cla-check.yml` is a **placeholder** — it just echoes "CLA enforcement placeholder. Replace this workflow with a real contributor signature or approval system" and passes for everyone, recording nothing. `CLA.md` (Loopdive GmbH terms) *does* grant an irrevocable, sublicensable, **relicensing** license — but only on a constructive "by contributing you agree" basis, with no signature, no bot, no record that any contributor saw or accepted it. That constructive-acceptance theory is weak for consequential **future relicensing** (commercial/proprietary). Surfaced when guest271314 opened PR #589 (first external contribution) and the question of relicensing rights came up.

**How to apply:**
- Replacing the placeholder with a real gate (CLA-assistant bot click-accept, or DCO `Signed-off-by` enforcement) is tracked as a plan issue (CLA gate). Until that lands, treat the green "cla-check" as meaningless.
- Before merging ANY external PR where relicensing matters, get the contributor's explicit CLA acceptance (bot comment / signed-off commit). Specifically: **hold guest271314's PR #589 until guest affirmatively accepts the CLA.**
- This is process/legal-adjacent — recommend legal review for the actual relicensing question; don't represent constructive acceptance as bulletproof.
- Relates to [[feedback_no_github_issue_comments]] / [[feedback_public_main_append_only]] — the broader "don't surprise or under-protect external contributors / the project" theme.
