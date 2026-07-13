---
id: 3028
title: "deploy-pages/ci baseline fetch: plain depth-1 clone of js2wasm-baselines pulls ~500 MB runs/ tree — 3-14 min per run"
status: done
sprint: 71
priority: high
horizon: s
feasibility: easy
area: ci
completed: 2026-07-04
assignee: ttraenkler/fable-lead
---

# #3028 — sparse + blob-filtered baselines clone in deploy-pages / ci

## Problem

The "Fetch baseline data from baselines repo" step in `deploy-pages.yml`
(and "Fetch runs/index.json from baselines repo" in `ci.yml`) did a plain
`git clone --depth=1` of `loopdive/js2wasm-baselines`. A depth-1 clone still
downloads **every blob at the tip commit**, which includes the `runs/`
merge-base cache — capped at ~500 MB of per-SHA run JSONLs. Measured step
durations in the last completed deploy-pages runs: **166s, 578s, 828s, 437s**
(runs 28686884490, 28686586096, 28686076835, 28687480960) — the step
dominated the whole deploy and was highly variance-prone, while the step only
reads 4 small-to-mid files:

- `test262-current.json` (~27 KB)
- `test262-current.jsonl` (~36 MB)
- `test262-standalone-current.jsonl` (~25 MB)
- `runs/index.json` (~190 KB)

`test262-sharded.yml` hit the identical problem earlier and fixed it with a
sparse + blob-filtered clone (its comment: "a plain --depth=1 clone took
~100s; materializing only the two baseline JSONLs takes ~2-5s") — but
`deploy-pages.yml` and `ci.yml` never got the same treatment.

## Fix

Apply the proven pattern from `test262-sharded.yml` to both steps:

```bash
git clone --depth=1 --filter=blob:none --no-checkout https://github.com/loopdive/js2wasm-baselines.git /tmp/js2wasm-baselines
git -C /tmp/js2wasm-baselines sparse-checkout set --no-cone <only-the-files-read>
git -C /tmp/js2wasm-baselines checkout main
```

- `deploy-pages.yml`: materialize `/test262-current.json /test262-current.jsonl /test262-standalone-current.jsonl /runs/index.json`
- `ci.yml`: materialize `/runs/index.json` only

Verified locally against the live baselines repo: full clone + sparse
checkout of all four files completes in **~4.0 s** (vs 166–828 s), and every
downstream `[ -f ... ]` guard in the steps still sees its file.

## Acceptance criteria

- [x] deploy-pages "Fetch baseline data from baselines repo" uses sparse + blob-filtered clone, all four consumed files materialize
- [x] ci.yml "Fetch runs/index.json from baselines repo" uses sparse + blob-filtered clone
- [x] Fallback semantics unchanged (`|| true`, `[ -f ]` guards) — a failed clone still degrades to stale/empty baseline warnings, never fails the build
