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
- Porffor PR #3287 retry `29641967485` at exact held head
  `a69b80aacee99c039d7456c79719822d3207fcc3` showed only 60 non-timeout host
  regressions and 92 pass→compile_timeout transitions. This is smaller than the
  proven same-compiler noise envelope, while all 114 shards and the standalone,
  CI, Differential, and CLA lanes passed.

Global numeric threshold increases would weaken every path and every compiler
change. The canary gives a stronger discriminator: the exact paths that changed
status with no compiler change.

## Root cause and prior mitigation

The pool mismatch documented by #3425 explained cross-environment timeout
churn, but it cannot explain run A versus run B at the same SHA, pool, corpus,
oracle, and workflow. The remaining status churn is path-specific host harness
or runtime nondeterminism. Repeating #3425 or raising the global ratio/timeout
limits would treat the symptom without preserving signal on stable paths.

## Scope

1. Derive a sorted manifest from artifact `8426392963` using the existing
   `scripts/test262-canary-diff.ts` parser. Include both pass flips and
   different-non-pass noise because either can enter a future pass→regression or
   compile-time transition depending on which canary side was promoted.
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

- [x] The committed manifest has exactly 510 unique entries: 360 pass flips and
      150 different-non-pass transitions, with run/SHA/artifact provenance.
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

1. Run the canary twice at the same current `main` SHA with the same pool,
   corpus, oracle, and runner image; require every shard and both merged JSONLs.
2. Download the `test262-canary-report` artifact and regenerate the manifest via
   `scripts/test262-canary-diff.ts --write-host-quarantine`, recording the new
   run ID, full compiler SHA, and artifact ID.
3. Review the manifest diff. Added paths require same-SHA evidence; paths absent
   from repeated clean canaries should be removed rather than retained
   defensively.
4. Remove the quarantine entirely once consecutive aligned same-SHA canaries
   report zero status changes. Never refresh it from a baseline-versus-PR diff.

## Implementation notes

The manifest stores both observed statuses and the transition kind. Loading is
fail-closed: malformed provenance, duplicate paths, inconsistent transition
kinds, or count mismatches abort the diff rather than silently widening or
emptying the quarantine. `diff-test262.ts` applies the resulting set only after
oracle/path-scope validation and only to host gate accounting; the original
maps remain intact for status totals and the trap ratchet.

## Implementation summary

- Extended `scripts/test262-canary-diff.ts` with an auditable
  `--write-host-quarantine` mode. It refuses incomplete canaries and requires
  the run ID, full compiler SHA, artifact ID, and compiler pool size.
- Generated `scripts/test262-host-noise-quarantine.json` directly from artifact
  `8426392963`. A clean regeneration produces a byte-identical file.
- `scripts/diff-test262.ts` validates the manifest fail-closed and applies it
  only when the existing standalone marker flag is absent. Host regressions,
  improvements, timeout counts, and aggregate compile time all use the stable
  subset; raw and quarantined values remain under distinct labels, and every
  observed quarantined transition is listed even under `--quiet`.
- The first workflow-parsed timeout and aggregate lines remain the authoritative
  stable-path values. No workflow YAML or threshold changed.
- The #3189 trap ratchet still receives the full baseline/candidate maps. A
  focused test proves a canary-listed path that newly enters `oob` remains a
  hard failure.

## Real-data validation and residual signal

Applying the implementation read-only to held #3287 retry run `29641967485`
against the current host baseline produced:

- 110 observed transitions on the exact canary set: 45 regressions, 41
  improvements, and 24 different-non-pass changes, all fully listed.
- pass→compile_timeout: raw 92 → stable 72 (20 quarantined).
- non-timeout pass regressions: raw 60 → stable 35 (25 quarantined).
- improvements: raw 174 → stable 133 (41 quarantined).
- aggregate compile time: raw −1.9%; stable subset −2.0%; quarantined subset
  +1.7%.
- trap populations held or improved (`null_deref 164→163`, `illegal_cast
80→80`, `oob 49→49`, `unreachable 55→55`).

The historical #3287 retry would still fail the unchanged 10% ratio (35/133 =
26.3%) and timeout threshold (72). Those 35 regression paths and 72 timeout
paths are outside the exact same-SHA evidence set, so this issue deliberately
does not waive them. Broadening the manifest from a PR-versus-baseline diff
would violate the stable-path and provenance invariants. #3287 remains held at
its exact head and was not modified or requeued.

## Test results

- `pnpm exec vitest run tests/issue-3426.test.ts`: 7/7 passed.
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
