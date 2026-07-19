---
id: 3303
title: "CI: add a PR-scoped regressions-allow mechanism for honest verdict-logic reclassifications (unifies the #1668/#1897/#3086 gates, unblocks #3104's landing without the temporary-lever dance)"
status: done
assignee: ttraenkler/sendev-3303
completed: 2026-07-16
created: 2026-07-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: ci-infra
goal: test-infrastructure
model: fable
sprint: 72
related: [3104, 3286, 3202, 3003, 3086, 1668, 1897]
---

# #3303 — a `regressions-allow:` mechanism for honest test262 reclassifications

## Problem

PR `#3104` (#3285 slice 1's `assert_throws` error-type tightening) has been
stuck for this entire session because landing an intentional, _correct_
reclassification (2615 residual non-excused wasm-change regressions —
previously-inflated false passes becoming honest fails, see #3286 for the
full story) currently requires a risky, multi-step "temporary-lever dance":
manually raise several hardcoded thresholds repo-wide, land, let
`promote-baseline` re-seed, then remember to revert the levers — a shared-
system risk (weakens the regression guard for every other in-flight PR during
the window) that nobody has had the budget/confidence to execute safely this
session.

This issue proposes the same fix already proven for exactly this class of
problem: `#3202` wired `TRAP_RATCHET_TOLERANCE` as a **GitHub repo variable**
specifically to make an otherwise-hardcoded ratchet tolerance adjustable
without touching code. This issue extends that pattern with a **PR-scoped**
allowance (like `loc-budget-allow`/`coercion-sites-allow`, not a global repo
variable) for the regression-count gates specifically, since — unlike a
ratchet tolerance that occasionally needs a one-time bump — a verdict-logic
reclassification is inherently a per-PR, per-change-set fact (this PR
reclassifies exactly N tests, for this stated reason) and a global repo
variable would leave the door open on every subsequent PR, not just the one
that earned it.

## The current gate architecture (grounded, verified 2026-07-16)

Three independent things currently gate a regression-heavy PR, and **none of
them currently consult each other**, which is itself part of the problem:

1. **`scripts/diff-test262.ts`'s own rebase-mode gate** (the file's own exit
   code / `gateFailed`):
   - `export const ORACLE_REBASE_DRIFT_TOLERANCE = 25;` (top of file, ~line 30s
     by byte offset 3272 — re-verify by symbol name, not line number)
   - `export const REGRESSION_BUCKET_LIMIT = 50;`
   - `rebaseMode` (line ~1030) is true when `oracleRebase` (the `ORACLE_REBASE=1`
     env flag) or a forward `oracle_version` bump is detected
   - Inside `rebaseMode` (lines ~1033-1058): fails if
     `regressionsWasmChange > ORACLE_REBASE_DRIFT_TOLERANCE`, or if any
     `bucketRegressions()` bucket exceeds `REGRESSION_BUCKET_LIMIT`
   - `regressionsWasmChange` (line ~880) is `noiseFiltered.length` —
     regressions with a changed wasm hash, AFTER excluding rows where
     `isVacuousResult`/`vacuousReclassification` is true (the #2940/#2463
     vacuity-scorer excusal — see `isExcusedVacuous`, line ~861). **This is
     the key limitation #3104 hits**: the excusal only covers
     vacuity-tagged flips (like #3086's 1438-flip precedent); #3285's 2615
     flips are plain `assertion_fail`/`type_error`, not vacuous, so none are
     excused and the raw 2615 hits the 25-test drift tolerance wall directly.

2. **`.github/workflows/test262-sharded.yml`'s "Catastrophic regression guard
   (#1668)" step** (~line 663-709): runs `diff-test262.ts` itself, but —
   **this is the structural bug this issue also fixes** — it does NOT use
   diff-test262.ts's own exit code / gate-failed determination at all. It
   only checks `diff_exit -gt 1` (script-crashed, not gate-failed) as a
   failure signal, then **independently re-parses** the printed
   `"Regressions with wasm-hash change: N"` line and fails if
   `N > CATASTROPHIC_REGRESSION_THRESHOLD` (hardcoded `"200"`), completely
   ignoring whether `diff-test262.ts` itself considered the PR a legitimate
   rebase. **This means even a working rebase-mode allowance inside
   diff-test262.ts would NOT be sufficient** — this workflow step would
   independently re-fail the same PR on the same raw number, regardless of
   any oracle bump or excusal.

3. **The standalone regression guard (#1897)**, same file (~line 716-810):
   mirrors #1 structurally, `STANDALONE_REGRESSION_TOLERANCE` hardcoded
   `"15"`, same independent-of-diff-test262's-own-gate structural pattern.

4. **`scripts/check-verdict-oracle-bump.mjs`** (#3003 gate): checks that a
   verdict-logic change also bumps `oracle_version`; its own guidance text
   already tells devs to "land the PR with `ORACLE_REBASE=1`" (line ~278) —
   but nothing in the codebase actually reads `ORACLE_REBASE` outside this
   one script's advisory text; it's not plumbed through to the workflow's
   env for the actual CI run. (Separately: this gate's `VERDICT_SIGNAL_RE`
   also has a real false-negative — it only matches `status:`-literal
   frontmatter changes, not runtime verdict-logic changes inside a shim body
   like #3104's `assert_throws` rewrite; worth a follow-up, not blocking this
   issue.)

## Design

Add a `regressions-allow:` frontmatter key to a PR's own issue file (same
mechanism as `loc-budget-allow`/`coercion-sites-allow` —
`changeSetAllowances()` in `scripts/lib/change-scope.mjs`, reading from
`plan/issues/*.md` files the PR's own diff touches, so it's inherently
PR-scoped with zero cross-PR conflict risk):

```yaml
regressions-allow:
  count: 2700
  reason: "#3285 assert_throws error-type tightening, see #3286"
```

(a numeric `count` ceiling + a required `reason` string — not a bare number,
so the allowance is self-documenting in `git blame`/PR review.)

**Wire it through all three gates, in one commit, so they stay consistent:**

1. **`diff-test262.ts`'s rebase-mode branch**: read the allowance (needs the
   PR's changed-issue-files diff, same input `changeSetAllowances()` already
   takes — `repoRoot`/`base`). When present and `regressionsWasmChange <=`
   the declared `count`, treat the residual as excused (log it explicitly as
   "regressions-allow: excused N of M declared, reason: ..."), skipping both
   the `ORACLE_REBASE_DRIFT_TOLERANCE` check AND the per-bucket
   `REGRESSION_BUCKET_LIMIT` check for buckets whose sum fits under the same
   declared ceiling. Reject (gate-fail loudly) if `regressionsWasmChange >`
   the declared count — the allowance is a ceiling a dev commits to, not a
   blank check; if reality exceeds what was declared, that's itself signal
   something changed and needs a fresh, honest re-declaration.
2. **Both hard guards in `test262-sharded.yml` (#1668 catastrophic + #1897
   standalone)**: fix the structural bug — use `diff-test262.ts`'s own exit
   code as authoritative (it already encodes rebase-mode + drift-tolerance +
   bucket-limit + now the new allowance-aware logic) instead of independently
   re-deriving a pass/fail from the raw printed regression count. This is a
   correctness fix independent of the new allowance feature — the two guards
   silently re-litigating a decision `diff-test262.ts` already made (and
   sometimes disagreeing with it) is a bug regardless of #3104.

## Safety guardrails (read before implementing — this gates the merge queue)

- The allowance is **per-PR, scoped by the PR's own diff** — never touch
  `scripts/loc-budget-baseline.json`-style shared committed baselines, and
  never make this a repo variable (`vars.*`) the way `#3202` did for
  `TRAP_RATCHET_TOLERANCE` — a verdict-logic reclassification is a one-time,
  per-PR fact, and a shared repo variable would silently apply to every
  subsequent PR forever, which is a much larger hole than intended.
- `regressionsWasmChange > declared count` must still hard-fail — this is a
  ceiling a human commits to in the PR's own issue file (reviewable in the
  diff), not an escape hatch that auto-scales to whatever the run produces.
- Do NOT let the allowance suppress the `#3189` uncatchable-trap growth
  ratchet (lines ~1009-1025) — that check explicitly says it applies "in
  BOTH the normal and the oracle-rebase branches" for good reason (a new trap
  is a distinct correctness signal, orthogonal to any reclassification). Keep
  it untouched.
- Test this against a synthetic fixture BEFORE trusting it on `#3104` itself
  — construct a small before/after JSONL pair with a declared allowance,
  confirm the gate passes at exactly the declared count and fails at
  declared+1, and confirm the two workflow guards agree with
  diff-test262.ts's exit code on both a rebase-mode PR and an ordinary PR.
- This unblocks `#3104` and any future case in `#3286`'s pattern, but do
  **not** apply the allowance to `#3104` yourself as part of this issue —
  that's a separate landing decision (`#3286`) once this mechanism exists and
  is validated. Land this as pure CI-infra first.

## Acceptance criteria

- `regressions-allow:` frontmatter key implemented, read via
  `changeSetAllowances()`-style PR-scoped diff logic (or a small
  purpose-built numeric-value counterpart if the existing helper's list-only
  shape doesn't fit cleanly — check before extending vs. duplicating).
- `diff-test262.ts`'s rebase-mode gate respects a valid allowance (ceiling
  semantics, excusal only up to the declared count, still fails above it).
- Both `test262-sharded.yml` hard guards (#1668, #1897) use
  `diff-test262.ts`'s own exit code as authoritative instead of independently
  re-deriving pass/fail from the raw regression count — fixing the
  structural inconsistency this issue found, independent of the new feature.
- The `#3189` trap-growth ratchet is unaffected by any allowance.
- A synthetic before/after fixture test validates ceiling-exactness (declared
  count passes, declared+1 fails) and cross-guard agreement.
- No change to any committed baseline file as part of this PR.
- `#3104`/`#3286` re-evaluated against the new mechanism as a FOLLOW-UP
  decision, not bundled into this PR.

## Implementation Notes (2026-07-16, sendev-3303)

What landed, and WHY each piece is shaped the way it is:

1. **`scripts/lib/change-scope.mjs` — `changeSetNumericAllowances()` +
   `parseFrontmatterCountReason()`** (new, purpose-built). The existing
   `changeSetAllowances()` is list-of-paths shaped (`parseFrontmatterList`
   cannot express a nested `count:`/`reason:` mapping), so extending it would
   have contorted both call sites; the new reader reuses the SAME
   `changedPaths()` change-set scoping, which is where the PR-scoping property
   actually lives. `reason` is REQUIRED — a declaration missing a
   positive-integer `count` or non-empty `reason` is reported as `invalid`
   (loud warning downstream) and grants nothing. Block form only, frontmatter
   only (a yaml example in an issue BODY — like the one in this file — parses
   as absent; pinned by test).

2. **`scripts/diff-test262.ts`** — `evaluateRebaseGate()` (pure, exported,
   #1943-style) now carries the whole rebase-mode verdict:
   - allowance present + `regressionsWasmChange <= count` → excusal note,
     drift-tolerance AND bucket checks superseded (total ≤ ceiling ⇒ every
     bucket's sum fits under it);
   - allowance present + above the count → loud `GATE FAIL: regressions-allow
ceiling exceeded` (ceiling semantics — reality exceeding the declaration
     is itself signal, re-measure and re-declare);
   - no allowance → the pre-existing #3086 tolerance-25 + bucket-50 checks,
     byte-identical messages (issue-2096 tests still pin them).
     The allowance is read **lazily inside the rebase-mode branch only** —
     deliberate containment: it has ZERO effect unless the same PR also bumps
     `oracle_version` forward (or CI sets `ORACLE_REBASE=1`), so an ordinary PR
     cannot use a declared allowance to sneak regressions past the
     net/ratio/bucket gate. The raw printed `Regressions with wasm-hash change:
N` line is NEVER altered — the guards' fallback parse stays honest.
     `REGRESSIONS_ALLOW_FILE` env reads the declaration from one explicit file
     (hermetic test hook + emergency lever); `/dev/null` disables. The #3189
     trap ratchet runs before and independent of this branch — untouched.

3. **`test262-sharded.yml` #1668 + #1897 guards — the structural fix.** Both
   now treat diff-test262.ts's exit code as **authoritative on PASS**:
   - exit >1 → propagate (script crash / refusal), unchanged;
   - exit 0 → guard passes regardless of the raw count (the script already
     encoded net/ratio/bucket + #3086 rebase tolerance + #3303 allowance +
     #3189 trap ratchet);
   - exit 1 → the coarse threshold (200 raw / net < −15) applies EXACTLY as
     before.
     Deliberately NOT full exit-code delegation (fail on exit 1): the script's
     normal-mode gate (net<0 / ratio≥10%) is far stricter than the guards'
     coarse thresholds, and importing it into the required `merge shard
reports` check would park every PR on ordinary baseline drift — the
     merge-queue-unsafe whole-tree-gate failure mode. In non-rebase mode
     exit 0 ⇒ net ≥ 0 ⇒ both guards passed anyway, so ordinary PRs see zero
     behaviour change; the only new pass shape is a deliberate re-baseline the
     script approved (which the guards previously vetoed — the disagreement
     this issue found).

4. **`merge-report` checkout `fetch-depth: 2`** — load-bearing. The guards run
   in that job; at the default depth 1 the synthetic merge commit's parents
   are unreachable, `resolveChangeBase`'s ci-merge-parent arm (`HEAD^1`)
   cannot resolve, and the allowance would be silently unreadable in exactly
   the job that gates the merge queue (merge_group AND the post-merge push
   run, whose green `merge shard reports` is what lets `promote-baseline`
   re-seed). The regression-gate job already checks out at depth 0.

5. **Tests (`tests/issue-3303.test.ts`, 32 tests, wired into ci.yml's quality
   step alongside issue-3004)**: parser edge cases; pure-gate ceiling
   exactness (30/30 passes, 31/30 fails); CLI end-to-end in rebase mode
   (exact-count pass, +1 fail, raw-count honesty, no-allowance tolerance,
   same-oracle inertness, trap-ratchet immunity, malformed-declaration
   warning); the REAL git change-set read in a temp repo (untracked issue
   file, LOC_GATE_BASE=HEAD); and a workflow-agreement harness that extracts
   the two guards' actual `run:` bash from the YAML and executes it against
   canned diff outputs (all 8 exit-code x raw-count combinations), so a
   future YAML edit that breaks the exit-code contract fails `quality`
   instead of silently re-wedging the queue. `tests/issue-2096.test.ts`
   pins `REGRESSIONS_ALLOW_FILE=/dev/null` so its rebase-mode fixtures stay
   hermetic once a real PR (e.g. #3104's landing) carries an ambient
   allowance in its diff.

6. **`scripts/check-verdict-oracle-bump.mjs` advisory text** updated: the
   clean path is now "forward-bump auto-rebases (#3086); declare
   `regressions-allow:` when the reclassification exceeds the 25-test
   tolerance" (the old text told devs to land with `ORACLE_REBASE=1`, which
   nothing in CI plumbs).

Heads-up for the #3286 landing decision (NOT handled here): a large honest
reclassification will also lower the standalone PASS COUNT, so the #2097
absolute high-water floor (`benchmarks/results/test262-standalone-highwater.json`,
checked by `check-standalone-highwater.mjs` in the same required job) may trip
independently of the regression gates. If #3104's flips include standalone
passes beyond that floor's tolerance, the landing PR must also adjust the
committed high-water file (deliberately, in-diff, reviewable) — the
regressions-allow ceiling does not and should not cover an absolute-floor
gate.

Follow-up candidates: the #3003 `VERDICT_SIGNAL_RE` false-negative (runtime
verdict-logic changes inside shim bodies, e.g. #3104's `assert_throws`
rewrite, are not matched) remains open, as noted in this issue's problem
statement.

Follow-up (from the 2026-07-16 #3104 landing, coordinator condition): the
#2097 standalone high-water floor has no sanctioned path for an HONEST
downward adjustment — its `--update` reseed runs post-merge only, but the
merge_group re-validates PRE-merge, so a legitimate reclassification that
lowers `host_free_pass` (the #3104 case) can only land via an ad hoc in-PR
edit of the committed mark. #3104 did this once as an explicitly-reviewed,
sign-off-recorded exception (−518 backed by a bucketed root-cause analysis;
an earlier unreviewed −3716 draft was rejected). If this class of situation
recurs, build the #2097 checker a proper reviewed-exception mechanism — a
per-PR, diff-scoped declaration with a required reason and an authorship/
review trail, analogous to what this issue built for the regression-count
gates — instead of repeating ad hoc mark edits.
