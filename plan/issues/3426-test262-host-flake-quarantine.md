---
id: 3426
title: "Quarantine exact same-SHA unstable host Test262 paths from fine gates"
status: done
sprint: current
created: 2026-07-18
updated: 2026-07-18
completed: 2026-07-18
priority: critical
horizon: m
feasibility: hard
reasoning_effort: max
task_type: infrastructure
area: testing
language_feature: n/a
goal: ci-reliability
depends_on: [3425]
related: [1217, 1942, 3287]
assignee: "ttraenkler/codex-sendev-test262-quarantine"
---

# #3426 — Quarantine exact same-SHA unstable host Test262 paths from fine gates

## Problem

PR #3363 fixed the known compiler-pool mismatch: baseline publication and
merge-group comparison now both use `COMPILER_POOL_SIZE=4`. That alignment was
necessary, but an authoritative canary under the aligned conditions proves a
second source of host-lane nondeterminism:

- Test262 canary run `29632875780` compiled compiler SHA
  `852c40a9f5167a2a959d53faa066cb0753b623cc` twice at pool size 4.
- All 114 shard jobs passed. Artifact `8426392963`
  (`test262-canary-report`) contains the two complete 48,088-row JSONLs.
- The same-SHA comparison found 360 pass↔non-pass flips and 150
  different-non-pass transitions, with no paths missing from either run.
- Independent current-main canary run `29643714720` compiled SHA
  `dae79d5a311a0bf683341230c39e6c5a7f6176ad` twice at pool size 4. All
  114 shards passed; only the expected flip-count compare failed. Artifact
  `8429653584` contains two complete 48,088-row JSONLs with zero missing paths,
  366 pass↔non-pass flips, and 165 different-non-pass transitions.
- The exact union is 932 paths; 109 paths are in the intersection and changed
  status in both independent same-SHA canaries.
- Porffor PR #3287 retry `29641967485` at exact held head
  `a69b80aacee99c039d7456c79719822d3207fcc3` showed only 60 non-timeout host
  regressions and 92 pass→compile_timeout transitions. This is smaller than the
  proven same-compiler noise envelope, while all 114 shards and the standalone,
  CI, Differential, and CLA lanes passed.

Global numeric threshold increases would weaken every path and every compiler
change. The canaries give a stronger discriminator: the exact union of paths
that changed status with no compiler change, with their repeat-confirmed
intersection retained for audit and removal decisions.

## Root cause and prior mitigation

The pool mismatch documented by #3425 explained cross-environment timeout
churn, but it cannot explain run A versus run B at the same SHA, pool, corpus,
oracle, and workflow. Reproducing hundreds of transitions in two independent
canaries, including a 109-path intersection, confirms path-specific host
harness or runtime nondeterminism. Repeating #3425 or raising the global
ratio/timeout limits would treat the symptom without preserving signal on
stable paths.

## Scope

1. Derive a sorted manifest from artifacts `8426392963` and `8429653584` using
   the existing `scripts/test262-canary-diff.ts` parser. Include both pass flips
   and different-non-pass noise because either can enter a future
   pass→regression or compile-time transition depending on which canary side
   was promoted. Eligibility is the exact union; record the exact intersection
   separately.
2. In `scripts/diff-test262.ts`, exclude only those exact paths from host-lane
   fine regression arithmetic and compile-time blocker arithmetic.
3. Keep raw and quarantined transitions visible under labels distinct from the
   workflow-parsed authoritative labels. List every quarantined transition in
   the report artifact.
4. Leave standalone strict. The existing standalone invocation is identified by
   `--exclude-leaky-baseline-regressions`; it must never load or apply the host
   quarantine.
5. Leave oracle/version checks, baseline files, hard-error checks, trap-category
   ratchets, vacuity handling, and global thresholds unchanged.

## Gate invariants

- The first `Compile timeouts (pass → compile_timeout): N` line is the
  unquarantined host count because the base-main workflow parses its first
  match.
- The first `Aggregate compile time (shared N tests)` line is computed over the
  unquarantined shared host set. Raw and quarantined aggregate measurements use
  distinct labels.
- Host improvements on quarantined paths are removed from the fine gate's ratio
  denominator as well as its regressions. Noise therefore cannot either block a
  change or mask a stable-path regression.
- Trap growth continues to evaluate the complete, unfiltered baseline and
  candidate maps. A quarantined path that newly traps still trips #3189.
- A catastrophic or one-way regression on any path outside the exact manifest
  retains the existing behavior.

## Acceptance criteria

- [x] The committed manifest has exactly 932 union entries and 109 intersection
      entries. It records all 726 pass-flip and 315 different-non-pass
      observations with both runs' SHA/artifact provenance.
- [x] A bidirectional host sample using canary-known paths passes and is fully
      reported as quarantined noise.
- [x] An equal stable-path one-way regression fails.
- [x] A canary-known path still fails under the standalone invocation.
- [x] An arbitrary path cannot opt into the quarantine.
- [x] Focused tests, typecheck, Biome, Prettier, and issue validation pass.
- [x] No workflow threshold, baseline content, oracle version, or global trap
      override changes.

## Refresh and removal procedure

The quarantine is evidence-bound, not a permanent allowance:

1. Collect at least two independent canaries. Within each canary, run the same
   current `main` SHA twice with the same pool, corpus, oracle, and runner image;
   require every shard and both merged JSONLs.
2. Generate the first selected canary with
   `scripts/test262-canary-diff.ts --write-host-quarantine`, then add the second
   with `--extend-host-quarantine`, recording each run ID, full compiler SHA,
   and artifact ID. The generator refuses incomplete reports and non-pool-4
   provenance.
3. Review union and intersection separately. Union additions require a status
   change in a complete same-SHA A/B canary; the intersection identifies paths
   reproduced in every selected canary. Never add a path from a
   baseline-versus-PR comparison.
4. Keep a bounded evidence window of the latest two complete aligned canaries:
   regenerate the first file without `--extend`, then extend it with the second.
   This removes an old path only after it is stable in both replacement
   canaries rather than retaining an append-only allowance forever.
5. Remove the quarantine entirely once two consecutive complete aligned
   canaries report zero status changes.

## Implementation notes

The manifest stores every canary's observed statuses and transition kind per
path. One complete same-SHA A/B status change is direct nondeterminism evidence,
so the exact union is eligible; independent canaries sparsely sample scheduler
noise, so requiring intersection would incorrectly relabel directly observed
noise as stable. The intersection remains explicit repeat-confirmation.

Loading is fail-closed: malformed or duplicate provenance, non-pool-4 data,
unsourced/duplicate observations, inconsistent transition kinds, or per-run and
aggregate count mismatches abort the diff rather than silently widening or
emptying the quarantine. `diff-test262.ts` applies the resulting set only after
oracle/path-scope validation and only to host gate accounting; the original
maps remain intact for status totals and the trap ratchet.

## Implementation summary

- Extended `scripts/test262-canary-diff.ts` with auditable
  `--write-host-quarantine` and `--extend-host-quarantine` modes. They refuse
  incomplete canaries, require pool size 4 plus full run/SHA/artifact
  provenance, and validate the merged result before writing it.
- Generated `scripts/test262-host-noise-quarantine.json` directly from artifacts
  `8426392963` and `8429653584`. A clean two-step regeneration produces a
  byte-identical file.
- `scripts/diff-test262.ts` validates the manifest fail-closed and applies it
  only when the existing standalone marker flag is absent. Host regressions,
  improvements, timeout counts, and aggregate compile time all use the stable
  subset; raw and quarantined values remain under distinct labels, and every
  observed quarantined transition is listed even under `--quiet`, marked as
  intersection or union-only evidence.
- The first workflow-parsed timeout and aggregate lines remain the authoritative
  stable-path values. No workflow YAML or threshold changed.
- The #3189 trap ratchet still receives the full baseline/candidate maps. A
  focused test proves a canary-listed path that newly enters `oob` remains a
  hard failure.

## Real-data validation and residual signal

Applying the two-canary union read-only to held #3287 retry run `29641967485`
against the current host baseline produced:

- 190 observed transitions on the exact union: 79 regressions, 67 improvements,
  and 44 different-non-pass changes, all fully listed. Of these, 30 are on the
  repeat-confirmed intersection and 160 are union-only.
- pass→compile_timeout: raw 92 → stable 55 (37 quarantined). The second canary
  directly explains 17 of the first canary's 72 residual timeout paths.
- non-timeout pass regressions: raw 60 → stable 18 (42 quarantined). The second
  canary directly explains 17 of the first canary's 35 residual paths.
- improvements: raw 174 → stable 107 (67 quarantined).
- aggregate compile time: raw −1.9%; stable subset −2.2%; quarantined subset
  +3.8%.
- trap populations held or improved (`null_deref 164→163`, `illegal_cast
80→80`, `oob 49→49`, `unreachable 55→55`).

The historical #3287 retry still fails the unchanged 10% ratio (18/107 = 16.8%)
and timeout threshold (55). Those 18 regression paths and 55 timeout paths are
outside both exact same-SHA evidence sets, so this issue deliberately does not
waive them. Broadening the manifest from a PR-versus-baseline diff would violate
the stable-path and provenance invariants. #3287 remains held at its exact head
and was not modified or requeued.

## Test results

- `pnpm exec vitest run tests/issue-3426.test.ts`: 8/8 passed, including a
  union-only sample, an intersection sample, and unsourced-observation rejection.
- Related gate suites: #1943, #2178, #2890, #3004, #3189, and #3303 passed.
  `tests/issue-1897.test.ts` has two pre-existing stale failures on current main:
  wording already changed in `enable-branch-protection.sh`, and a fixture that
  expects a 1:1 regression ratio to pass despite the existing #1943 10% gate.
- `pnpm run typecheck`: passed.
- Focused Biome lint: passed.
- Focused Prettier check: passed.
- `pnpm run check:issues`: passed (0 issue-file normalizations).
- `pnpm run check:issue-ids:against-main`: passed.
- `pnpm run check:issue-spec-coverage`: passed.
- Full Test262 was not run locally; the required merge-group matrix is the
  authoritative validation and the baseline was not refreshed.
