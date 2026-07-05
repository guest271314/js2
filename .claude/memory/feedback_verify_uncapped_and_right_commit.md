---
name: feedback_verify_uncapped_and_right_commit
description: "Before claiming an AST/output 'parses equal', verify UNCAPPED and on the RIGHT commit — capped diffs and stale checkouts both produced false 'equal' this session"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

Two separate false "parses equal" calls in the acorn epic, both from trusting
incomplete verification — don't repeat:

1. **Capped differential.** `tests/dogfood/...nm-diff.mjs` runs `diffAst` with
   `maxDivergences: 8`, and the differ **early-exits** at the cap (stops
   walking). "nonQuirk == 0" on that output only checks the first 8 divergences
   — all near-root `sourceFile`/bool quirks — and **never reaches function
   bodies**. Uncapped (`maxDivergences: 100000`), background.js had 2 real
   `missing-field` divergences and edge.js had 66 (arrow/fn-expr param
   `name`/`type` dropped). **Always raise the cap and classify ALL divergences
   before concluding equal.**

2. **Stale checkout.** A `git fetch` that raced the merge-queue → origin
   propagation put a `verify` worktree one commit *before* the fix (#2836), so
   `(a)=>a` "threw on main" — a phantom regression. **Confirm the worktree HEAD
   actually contains the fix commit (`git merge-base --is-ancestor <fix> HEAD`)
   before interpreting results.**

**How to apply:** an agent's "verified, parses equal" is necessary but not
sufficient — re-verify yourself UNCAPPED and on a checkout you confirmed has the
fix. Pairs with the broader pattern that each acorn architect spec was
"necessary-but-not-sufficient on a synthetic repro" — the iron rule that broke
it was verifying against the REAL target (compiled acorn end-to-end), not a
proxy. See [[feedback_verify_fix_in_git_not_narrative]],
[[feedback_verify_local_repro_against_known_good_control]].
