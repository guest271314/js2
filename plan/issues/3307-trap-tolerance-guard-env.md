---
id: 3307
title: "CI: pass TRAP_RATCHET_TOLERANCE to the #1668/#1897 guard steps — post-#3303 the guards' exit-1 fallback makes the tolerance omission disagree with the regression-gate job on identical data"
status: done
assignee: ttraenkler/sendev-3303
completed: 2026-07-16
created: 2026-07-16
priority: high
feasibility: easy
task_type: bug
area: ci-infra
goal: test-infrastructure
sprint: 72
related: [3303, 3202, 3189, 3104]
---

# #3307 — TRAP_RATCHET_TOLERANCE consistency between the guard steps and the regression-gate job

## Problem

The `#3189` uncatchable-trap growth ratchet runs inside `diff-test262.ts` and
reads `TRAP_RATCHET_TOLERANCE` from the environment. `#3202` wired that env
from the repo variable `vars.TRAP_RATCHET_TOLERANCE` (currently `4`, set
during the 2026-07-12 queue-wedge: a CI-sharded-only +4 `oob` flap on the 4
unsupported-BigInt `TypedArray.prototype.set` tests) — but **only in the
`regression-gate` job's env**. The `#1668` catastrophic and `#1897`
standalone guard steps in `merge-report` run the SAME script on the SAME
data with the env **unset** (script default `0`).

Pre-#3303 that omission was dead config: the guards ignored the script's
exit code (they only checked `> 1`), so a trap-driven exit 1 never mattered
there. **Post-#3303 it has teeth**: the guards now fall back to their coarse
raw-count thresholds exactly when the script exits 1 — so a trap-flake exit 1
(e.g. the known `oob 52→53` flap, visible in PR #3104's 2026-07-15
merge_group run) makes the guard re-litigate the raw count. For an ordinary
PR (raw < 200) nothing changes, but for a declared re-baseline
(`regressions-allow`, #3303) the coarse threshold then fails a run the
regression-gate job — with its tolerance-4 env — passes. Two gates, same
data, different verdicts: the exact inconsistency class #3303 removed.

## Fix

Add the same env line the regression-gate job already uses to both guard
steps in `.github/workflows/test262-sharded.yml`:

```yaml
TRAP_RATCHET_TOLERANCE: ${{ vars.TRAP_RATCHET_TOLERANCE || '0' }}
```

No script change; no behaviour change while the var is `0`. The var remains
the single sanctioned ratchet valve (#3202) and now applies uniformly to
every diff-test262 invocation in the workflow.

## Validation

- `tests/issue-3303.test.ts` is the permanent pin for these two guard steps:
  its workflow-agreement harness extracts and EXECUTES the exact `run:` bash
  of both steps against canned diff outputs, so any edit that changes the
  guards' decision logic fails the `quality` job. This change adds only
  step-level `env:` keys (not part of the executed run body), and the harness
  passes unchanged — verified locally on this branch.
- Live validation: PR #3104's measurement run showed the exact disagreement
  this fixes — host-lane diff at guard-tolerance 0 gate-fails on
  `oob 48→53` while the regression-gate job's tolerance-4 env absorbs the
  4-test known flap (`test262/test/built-ins/TypedArray/prototype/set/BigInt/`
  cluster, #3202).

## Notes

- Found while landing #3104 via the #3303 mechanism (the trap flap would
  have nullified the allowance in the guards while the fine gate passed).
- Must land on main BEFORE #3104 enqueues — merge_group runs main's YAML.
