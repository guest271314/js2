---
name: reference_loc_budget_post_3131_no_commit_baseline_use_allow_frontmatter
description: "Post-#3131, the LOC-regrowth ratchet FORBIDS committing scripts/loc-budget-baseline.json in a PR — `check:loc-budget --update` is the obsolete pre-#3131 path and now fails the `quality` gate. For intended growth, drop the baseline change (take main's) + add `loc-budget-allow: [<file>]` to the PR's issue-file frontmatter."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

The LOC-regrowth ratchet (#3102 / #3131) changed how loc-budget conflicts are
resolved. The OLD advice — resolve a `scripts/loc-budget-baseline.json` conflict
with `pnpm run check:loc-budget --update` and commit the regenerated baseline —
is now WRONG and makes the `quality` gate fail in the merge_group (auto-parks the
PR). #3131 forbids a PR from committing `loc-budget-baseline.json`: the baseline
refreshes **post-merge on main only**, and the gate's own error text says so.

**Correct resolution for a loc-budget / god-file-growth failure (post-#3131):**
1. In any `loc-budget-baseline.json` merge conflict, take **main's** version
   (`git checkout --theirs scripts/loc-budget-baseline.json` / drop your change) —
   never commit a modified baseline.
2. If the growth is INTENTIONAL (a real feature slice legitimately grows a
   tracked file, e.g. `src/ir/from-ast.ts`), add an allowance to the PR's **own
   issue-file frontmatter**: `loc-budget-allow: [src/ir/from-ast.ts]`. That
   frontmatter allowance is what the gate honors for intended growth.
3. Verify locally with `pnpm run check:loc-budget` (NOT `--update`) + `tsc` +
   scoped tests, then push.

**Diagnostic signature:** merge_group `quality` fails ONLY (test262 sharded +
equivalence shards all PASS) with `<file>: NNNN > MMMM (+K)` — that's the ratchet,
not a conformance regression. Confirmed on #2868 (from-ast.ts 6785 > 6684 +101),
#2865, #2871 (senior2 used the frontmatter-allowance path), all 2026-07-10.

Do NOT put `check:loc-budget --update` in dev spawn prompts anymore. Related:
[[reference_ci_quality_format_uses_prettier_not_biome]].
