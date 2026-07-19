---
id: 3273
title: "Oracle ratchet gate: make change-scoped (net) — stop whole-tree re-flagging sibling split modules"
status: done
assignee: ttraenkler/senior-dev-oracle
sprint: 72
created: 2026-07-14
updated: 2026-07-19
completed: 2026-07-14
priority: high
horizon: m
feasibility: hard
model: opus
reasoning_effort: max
task_type: refactor
area: ci
language_feature: compiler-internals
goal: maintainability
related: [1930, 3131, 3102, 2108, 3272, 3270, 3271]
---

# #3273 — Oracle ratchet: change-scoped (net), like the #3131 loc/coercion rework

## Problem

`scripts/check-oracle-ratchet.mjs` (the "Oracle ratchet (#1930)" step in the
`quality` job) was WHOLE-TREE: it `walk()`ed all of `src/codegen/**` and
compared each file's direct-TS-checker call-site count (`getTypeAtLocation(`,
`ctx.checker`) against a committed snapshot,
`scripts/oracle-ratchet-baseline.json`. Unlike `check:loc-budget` and
`check:coercion-sites` — which were already reworked change-scoped in #3131 —
this gate still judged the entire tree against a frozen baseline that has **no
post-merge auto-refresh** (no workflow runs `check:oracle-ratchet --update`;
grep `.github/workflows/`).

That is merge-queue-UNSAFE during the god-file breakdown
(memory `reference_ci_gate_change_scoped_not_wholetree_absolute`): a split PR
moves checker sites out of a god-file into new sibling modules that the frozen
baseline never banked, so the whole-tree gate flags those new modules (baseline
0 → tree N). Worse, once one split lands, **every other open split PR that
re-merges main inherits the new sibling module and gets flagged for a file it
never touched**, unless it re-declares a per-issue allowance for it — a per-wave
treadmill. Three byte-identical refactor PRs — #3069 (index.ts), #3067
(closures.ts), #3066 (generators-native.ts) — were bot-parked on exactly this
(`quality` failed in the `merge_group`; Test262 green, no real regression).

## Root cause

Same class as #3131: the gate's _memory_ (a frozen whole-tree baseline) is
decoupled from the PR's _change-set_, so an unrelated main advance (a sibling
split landing) re-flags files the PR did not touch. The oracle metric adds one
twist over loc/coercion: a god-file split **relocates** existing checker sites
source→new-module, so the change is **net-neutral** — no new oracle debt — yet a
naive per-file "any increase fails" rule flags the new module.

## Fix (the #3131 precedent, adapted to a two-field, relocation-heavy metric)

Make the DEFAULT run change-scoped via the shared helper
`scripts/lib/change-scope.mjs` (`resolveChangeBase`, `changedPaths`, `baseBlob`,
`changeSetAllowances`), exactly as `check-coercion-sites.mjs` /
`check-loc-budget.mjs` do:

- **Base resolution**: `LOC_GATE_BASE` env → CI synthetic-merge `HEAD^1` (the
  exact base tree, present at `fetch-depth: 2`) → `merge-base origin/main HEAD`
  → `origin/main` tree-diff → (no git) legacy whole-tree fallback.
- **Judge only the change-set**: for each changed `src/codegen/*.ts` file, count
  the two checker patterns at the BASE blob vs the WORKING TREE. The committed
  baseline is NOT consulted on this path; PRs must NOT commit changes to it.
- **NET, not per-file** (the key adaptation): fail only when the change-set's
  **per-field net** (Σ over changed, non-allowed files of `now − was`) grows.
  A verbatim relocation (source −N, new module +N) nets to zero and passes
  without any allowance; a genuinely new checker call with no offsetting removal
  nets positive and still fails. This matches the ratchet's real job — prevent
  GROWTH of total direct-checker usage under `src/codegen/`, not freeze the
  physical file each site lives in. A sibling module inherited via merge is
  identical at the base and the working tree, so it is not in the diff at all →
  never evaluated.
- **Intentional net growth hatch** moves off the shared file: list repo-relative
  path(s) under an `oracle-ratchet-allow:` key in the PR's own
  `plan/issues/*.md` frontmatter (unique file per PR ⇒ conflict-free), mirroring
  `loc-budget-allow` / `coercion-sites-allow`.
- **Preserved**: `--update` (whole-tree reseed, main/post-merge only),
  `--update-on-decrease` (bank shrinks), `--verbose`. **Added**: `--all`
  whole-tree audit vs the committed baseline (local use), and a no-git
  fallback so the gate never crashes a hook outside a git context.
- CI step (`ci.yml` `quality`) gains a best-effort `git fetch origin main`
  before the gate (feeds the merge-base fallback), mirroring the loc-budget
  step. `fetch-depth: 2` already exposes the synthetic-merge `HEAD^1`.

## Validation (proved both directions)

Measured with the gate's exact counting method (base blob vs head), the three
parked PRs are **exactly net-zero** on both fields:

- #3069: `index.ts` −14 gTAL / −38 ctxChk moved into `extern-declarations.ts`
  (+14/+37) and `wasi.ts` (+0/+1) → net 0 / 0.
- #3067: `closures.ts` −3 / −5 moved into `closures/callback-classification.ts`
  (+3/+5) → net 0 / 0.
- #3066: `generators-native.ts` −1 / −3 moved into
  `generators-native-consumer.ts` (+1/+3) → net 0 / 0.

- **TRUE POSITIVE preserved**: an edited `src/codegen` file that gains a new
  `ctx.checker.getTypeAtLocation(...)` with no offsetting removal → net +1/+1 →
  gate FAILS (exit 1), and PASSES again once the file is listed under
  `oracle-ratchet-allow:`.
- **FALSE POSITIVE eliminated**: a verbatim relocation (new module +N, source
  −N) nets 0 → PASSES with no allowance; a sibling module present at the base
  but not in the change-set's diff is never evaluated → PASSES, whereas the
  legacy whole-tree (`--all`) path flags it.

## Impact

Unblocks the 3 parked Wave-A split PRs (#3069/#3067/#3066) and every future
god-file split, with no per-PR baseline bump and no allowance needed for
net-neutral relocations.
