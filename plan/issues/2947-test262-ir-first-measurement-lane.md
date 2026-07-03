---
id: 2947
title: "test262-sharded workflow_dispatch ir_first lane — repeatable off-box #2138 measurement"
status: done
completed: 2026-07-02
sprint: 69
created: 2026-07-02
updated: 2026-07-03
priority: medium
feasibility: easy
horizon: s
task_type: infra
area: ci
goal: maintainability
related: [2138, 2135]
origin: "2026-07-02 tech-lead decision — #2138 Slice 3 needs an idle box or a CI lane; the dev box runs 9 agents"
---

# test262-sharded `ir_first` dispatch lane (#2138 Slice-3 measurement, off-box)

## Problem

#2138's acceptance criterion 2 needs a full `JS2WASM_IR_FIRST=1` test262 +
compile-time run. The shared dev box cannot host it (load ≈ 12–14 on 8 cores
with the agent pool active; wall-clock variance ±45% made compile-time deltas
unmeasurable — see #2138 `## Measurement`), and team rules bar devs from
local full test262 anyway. The measurement must be repeatable and off-box.

## Implemented (rides the #2135 slice-1 PR)

`.github/workflows/test262-sharded.yml`:

- New `workflow_dispatch` input **`ir_first`** (boolean, default false).
- Shard-job env: `JS2WASM_IR_FIRST: ${{ github.event_name ==
  'workflow_dispatch' && inputs.ir_first && '1' || '' }}` — `'1'` only on an
  opted-in dispatch; the empty string on every other event is falsy for the
  compiler's `truthyEnv` reader, so all default lanes (PR / push /
  merge_group / plain dispatch) are behaviorally identical. Compile workers
  inherit the job env; the runner compiles every test fresh (no cross-run
  result cache — deliberate, workflow line ~485), so a flagged dispatch
  measures a full clean compile.
- **`promote-baseline` is hard-skipped for `ir_first` runs**
  (`!(github.event_name == 'workflow_dispatch' && inputs.ir_first)` added to
  the job `if:`). A flagged run promoting its pass-set would poison the
  regression baseline every PR gates against; the merged-report ARTIFACT is
  the measurement deliverable instead.

## How to run the measurement (lead)

1. Actions → "test262 sharded" → Run workflow on `main`, `ir_first: true`.
2. Compare the run's merged report artifact against the current baseline
   JSONL (`scripts/fetch-baseline-jsonl.mjs` + `/analyze-regression`); every
   flag-ON-only failure is a loud #2138 divergence — bucket by error class,
   file per class (as #2945 was).
3. Compile-time delta: compare the run's shard wall-times against a same-SHA
   unflagged dispatch (the shards are duration-weighted, so per-shard deltas
   are directly comparable).
4. Record results in #2138 `## Measurement (JS2WASM_IR_FIRST)`.

## Acceptance criteria

- Dispatch with `ir_first: true` runs all shards with the flag exported and
  never touches the baseline. — implemented, guard verified by inspection
  (`inputs.*` is empty on push events → guard passes unchanged).
- Default lanes byte-identical in behavior (empty-string env). — implemented.
