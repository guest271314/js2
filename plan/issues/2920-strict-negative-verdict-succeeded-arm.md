---
id: 2920
title: "Strict compile-SUCCEEDED arm of the negative-test verdict (the #2912 follow-up, intentional −439)"
status: in-review
assignee: ttraenkler/dev-2912
priority: medium
sprint: current
created: 2026-07-02
feasibility: medium
task_type: bug
area: tooling
goal: developer-experience
related: [2912, 2898, 2911]
---

# #2920 — Strict compile-SUCCEEDED arm of the negative-test verdict

Follow-up to #2912 (which landed the safe compile-FAILED arm and the shared
`scripts/negative-verdict.mjs`). This is the **intentional, maintainer-approved
−439 conformance drop** that makes the negative-test count honest.

## Problem

For a negative `phase: parse | early | resolution` test, #2912 left the
compile-SUCCEEDED arm deliberately lenient: when the compiler emitted **no**
diagnostic, the runner still scored a `pass` whenever the produced Wasm merely
**failed to instantiate/link** — an INCIDENTAL pass (the #2898 fragility). A
full-corpus audit (2026-07-01, recorded in #2912) found **~439 host-lane
negatives** passing ONLY this way — real early-error-detection GAPS, not
conformance passes:

- `await` / `yield` as a binding identifier
- escaped keywords
- duplicate module exports
- unresolved imports

Category breakdown (from the #2912 audit): `language/expressions` 133,
`module-code` 128, `statements` 117, plus asi / punctuators / keywords /
literals.

## Fix (landed in this PR)

Strict verdict in **all three** runners, via a single shared helper
`negativeCompileSucceededVerdict(expectedType, phase)` in
`scripts/negative-verdict.mjs` (returns `{status:"fail", error}` — a compile
with no diagnostic is a missed early error, regardless of whether the Wasm
subsequently instantiates/links):

- `scripts/test262-worker.mjs` (main CI worker path) — was the
  `try instantiate → pass on throw` block.
- `tests/test262-shared.ts` (fixture / in-process path) — the fixture catch now
  splits `isRuntimeNegative` (still pass on a start-function throw) from
  `isNegative` (strict fail).
- `tests/test262-vitest.test.ts` (legacy two-phase runner).

Identical across `gc` / `standalone`. Unit test: `tests/issue-2920.test.ts`.

## Landing mechanics (IMPORTANT — the #2912 split plan has a gap)

This is a verdict-only change (byte-identical compiled Wasm; only the pass/fail
score flips). The #2912 resolution assumed the drop could land via a maintainer
`force_baseline_refresh` dispatch. **Verified against the current
`test262-sharded.yml`, that path does NOT work for a −439 drop:**

1. **The CI shard JSONL carries no `wasm_sha`.** `tests/test262-shared.ts`
   `recordResult` (the CI producer) does not emit a `wasm_sha` field (confirmed
   against `.test262-cache/test262-current.jsonl`). So `diff-test262.ts`'s
   byte-identical "wasm-identical noise" filter — which would exempt a
   verdict-only flip — is **inert in CI**: every one of the 439 flips counts as
   a real `regressionsWasmChange`.
2. **`#1668` catastrophic guard (threshold 200) blocks it.** That guard lives
   inside the REQUIRED `merge shard reports` job, runs on `SHARDS_RAN == true`
   (i.e. `merge_group` **and** `workflow_dispatch`), and has **no**
   `force_baseline_refresh` exemption. 439 > 200 → the job fails on the PR's
   `merge_group` run AND on a `force_baseline_refresh` dispatch — so
   `promote-baseline` (`needs: merge-report`) never runs on the dispatch, and
   the baseline can't be re-seeded that way.
3. **`force_baseline_refresh` only skips the fine-grained "Fail on regressions"
   step** (`regression-gate` job), not the inline `#1668` / `#1897` / `#2097`
   guards inside `merge shard reports`.

So an intentional −439 needs a coordinated infra step beyond the issue's stated
plan. Options (a lead/maintainer decision — escalated):

- **(A)** Temporarily raise `CATASTROPHIC_REGRESSION_THRESHOLD` (e.g. to 500)
  for this one landing, admin-merge / queue it, then `promote-baseline` on
  push:main re-seeds the honest baseline; restore the threshold in a follow-up.
- **(B)** Land a small **prerequisite** PR adding `wasm_sha` emission to the CI
  shard runner (`tests/test262-shared.ts` / the worker), let `promote-baseline`
  refresh the baseline WITH `wasm_sha`, THEN land this verdict flip — it then
  classifies as "wasm-identical noise" and passes `#1668`/`#1897`/regression
  gate cleanly, leaving only `#2097` (fix by lowering the committed high-water
  mark; `promote-baseline --update` re-ratchets it up post-merge).
- **(C)** Wire `ORACLE_REBASE=1` (the #2096 mechanism) into the workflow AND
  raise `#1668`, then a `force_baseline_refresh` dispatch can re-seed. Note:
  `ORACLE_VERSION` has never been bumped (still 1) and this plumbing is
  currently unwired.

### Standalone high-water floor (`#2097`)

Any of the 439 that are `host_free_pass` on the standalone lane also drop the
absolute standalone floor (tolerance 50). This is an **absolute-count** gate
(not a wasm-hash diff), so it trips independently. The fix is to lower the
committed `benchmarks/results/test262-standalone-highwater.json` mark in the
landing PR; `promote-baseline --update` (which only ratchets UP) re-keys it to
the honest number on the next push:main. NOT touched in this PR pending the
chosen landing path (the exact new standalone count isn't known without a full
standalone run).

## Acceptance

- Compile-SUCCEEDED arm records `fail`, not an incidental `pass`, for negative
  parse/early/resolution tests where the compiler emitted no diagnostic.
- Behaviour identical across `gc` and `standalone`, and across all three
  runners (single shared helper).
- Lands with a coordinated baseline refresh so the merge queue is not wedged.
