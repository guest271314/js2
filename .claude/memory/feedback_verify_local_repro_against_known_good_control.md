---
name: feedback_verify_local_repro_against_known_good_control
description: "When a local repro disagrees with a CI signal, validate the repro against a KNOWN-GOOD control reading the SAME field the source-of-truth uses, before trusting it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

When a local reproduction disagrees with an authoritative CI signal (e.g. a
`merge_group` standalone-floor park says PR #1960 regressed, but my local
`runTest262File(…, "standalone")` showed the same failures on the pre-change
base), do NOT conclude "the CI is wrong / it's baseline drift" until the local
repro is validated against a KNOWN-GOOD control.

**Why:** on #1960 I read the wrong result field — `r.outcome` (always
`undefined` on the runner's `TestResult`, which uses `.status`) instead of
`r.status`. Every probe looked like a uniform failure, which I misread first as
"all tests fail identically on base = baseline drift", then as "my local harness
is broken." Both were wrong. The regression was REAL (the lead's CI evidence was
right). A single probe bug produced two confident-but-false verdicts and nearly
led to accepting a real §9.8.1 ToString conformance regression. The discriminator
that finally exposed it: run a test the baseline records as a genuine `pass` and
confirm the probe reports `pass` for it. It didn't (it printed `undefined`) →
the probe, not the compiler, was the problem.

**How to apply:**
1. Before trusting a local repro that contradicts CI, run a KNOWN-GOOD control —
   a case the source-of-truth (baseline JSONL / CI) records as the expected
   outcome — through the SAME probe. If the control doesn't reproduce its known
   outcome, the probe is broken; fix the probe before drawing any conclusion.
2. Read the EXACT field the source-of-truth uses. Check the function's return
   type (`runTest262File` returns `{status: "pass"|"fail"|"skip"|"compile_error"}`,
   NOT `outcome`). A field that's always `undefined` is a silent tell.
3. Use a proper base-vs-branch A/B: clean-`origin/main` vs the change-branch,
   same probe, same field — only a DIFFERENCE between them is signal.
4. The authoritative CI signal (`merge_group` park) outranks a local repro until
   the repro passes its own control. **[[feedback_baseline_drift_cross_check]]**
   still applies (identical signature across PRs ⇒ drift), but confirm the local
   tool first.

Related: a bot `auto-park-bot:merge-group-failure` `hold` is a REAL merged-baseline
regression flag, not a manual WIP label — never clear it without diagnosing the
cited run AND fixing the branch first (CLAUDE.md auto-park rules a/b/c).
