---
id: 2920
title: "Strict compile-SUCCEEDED arm of the negative-test verdict (the #2912 follow-up, intentional −439)"
status: done
assignee: ttraenkler/dev-2912
priority: medium
sprint: 69
created: 2026-07-02
completed: 2026-07-02
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
plan. **Lead decision (2026-07-02): Option A, executed in this PR.**

- **(A) — CHOSEN & EXECUTED:** three TEMPORARY, same-PR levers (all reverted
  together in the #2920 revert PR), each with a loud comment referencing the
  revert:
  1. `.github/workflows/test262-sharded.yml`
     `CATASTROPHIC_REGRESSION_THRESHOLD` **200 → 500** (the `#1668` guard inside
     `merge shard reports`). 439 < 500 lets the merged tree through.
  2. The `check for test262 regressions` job is a SEPARATE required gate
     (deliberately does NOT need merge-report; self-builds the host JSONL and
     diffs the fresh baselines-repo baseline via `diff-test262.ts`). It is NOT
     covered by the `#1668` raise, and it bot-parked #2424 on the first
     merge_group. Fix: a new `INTENTIONAL_REGRESSION_BUDGET` env in
     `diff-test262.ts` (default 0 = no effect) that waives the net/ratio/bucket
     gates when the wasm-change regression count is ≤ the budget; set to **500**
     on the merge_group regression-diff step. A real regression > 500 still
     fails (verified). Mirrors lever 1.
  3. `benchmarks/results/test262-standalone-highwater.json` — see below.

  After this merges, `promote-baseline` on push:main re-seeds the honest
  baseline; the **revert PR** (restore `#1668` to 200, set the budget back to 0)
  follows immediately, keeping the temporary-window as short as possible. The
  standalone floor is left at its re-ratcheted honest value. NOTE: the standalone
  `#1897` net-guard and `#2097` floor both PASSED on the first merge_group run
  (the standalone flip count is within tolerance and the floor lower by 439 was
  sufficient) — only the host `check for test262 regressions` gate needed lever 2.

- **(B)** (deferred to a Backlog improvement issue) — emit `wasm_sha` in the CI
  shard JSONL so `diff-test262`'s wasm-identical-noise filter works in CI; that
  is the _permanent_ fix for this whole class of verdict-only landing, removing
  the need for a threshold bump next time.
- **(C)** Wire `ORACLE_REBASE=1` (#2096) + raise `#1668` — not pursued.

### Standalone high-water floor (`#2097`) — handled in this PR

Any of the 439 that are `host_free_pass` on the standalone lane also drop the
absolute standalone floor (tolerance 50). This is an **absolute-count** gate
(not a wasm-hash diff), so it trips independently. The zero-diagnostic compile
set is **target-independent** (parse/early-error detection is the shared
front-end), so the standalone flip set equals the host flip set (439 files) and
the standalone `host_free_pass` drop is a **subset** of those → **≤ 439**. So
439 is a tight, safe upper bound. The committed
`benchmarks/results/test262-standalone-highwater.json` mark is lowered by 439
(`pass`/`host_free_pass` 18241 → 17802, `official_pass` 17890 → 17451).
`promote-baseline --update` (which only ratchets UP) re-keys it to the **exact**
honest number on the post-merge push:main run — so a full pre-merge standalone
audit (which would only widen the temporary-threshold window) is unnecessary;
the value self-heals to exact.

## Acceptance

- Compile-SUCCEEDED arm records `fail`, not an incidental `pass`, for negative
  parse/early/resolution tests where the compiler emitted no diagnostic.
- Behaviour identical across `gc` and `standalone`, and across all three
  runners (single shared helper).
- Lands with a coordinated baseline refresh so the merge queue is not wedged.

## Revert record (2026-07-02, the revert PR)

Re-seed verified before reverting (required ordering — the revert's own gates
at 200/budget-0 must diff against the honest baseline):

- #2424 merged at `9d37728` (2026-07-02T01:05Z). Its own push:main run passed
  `merge shard reports` but its `promote-baseline` job **failed** — a
  persistent push race against `js2wasm-baselines` (another run's promote
  landed first; the wholesale-regenerated JSONLs never rebase cleanly, so all
  5 retries conflicted identically).
- The **next** push:main run (`dacd7fd`, run 28558439826 — a descendant of
  #2424) promoted successfully at 01:28Z: baselines-repo HEAD `71d3569`
  ("33283/43135 host, 25825/43137 standalone (dacd7fd)"). The gate baseline is
  honest/post-#2424.
- Standalone high-water: the same promote raised the host-free mark
  17802 → 18353 in-job; the direct-to-main commit of the refreshed mark was
  deferred ("merge queue has 3 entries", #1951 fail-open) and lands via the
  scheduled refresh. The committed 17802 floor is strictly permissive — the
  revert leaves `test262-standalone-highwater.json` untouched.

Levers restored by the revert PR: `CATASTROPHIC_REGRESSION_THRESHOLD`
500 → 200 (#1668 guard), `INTENTIONAL_REGRESSION_BUDGET` removed from the
regression-diff step AND the temporary waiver block removed from
`scripts/diff-test262.ts` (its default was already 0; the block self-documented
as revert-together). Permanent fix for this class of landing: #2926 (emit
`wasm_sha` in the shard JSONL — filed with the revert PR).
