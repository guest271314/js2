---
id: 3677
title: cheap gate aborts at `wait` under `bash -e` — every failure is diagnostic-free and lint hard-fails against its own declared intent
status: in-progress
sprint: current
priority: high
horizon: s
feasibility: easy
area: ci
goal: ci-reliability
related: [3437]
assignee: ttraenkler/pr-queue-shepherd
created: 2026-07-26
---

# #3677 — cheap gate swallows its own diagnostics under `errexit`

## Problem

The required check **`cheap gate (main-ancestor + lint)`**
(`.github/workflows/test262-sharded.yml`, step "Typecheck + lint (parallel)")
runs under GitHub's default `shell: /usr/bin/bash -e`. The script did:

```bash
wait $pid_tc;   tc_rc=$?
wait $pid_lint; lint_rc=$?
echo "--- typecheck (last 50 lines) ---"; tail -50 "$tmp_tc"
echo "--- lint (last 50 lines) ---";      tail -50 "$tmp_lint"
if [ "$tc_rc" -ne 0 ]; then echo "::error::typecheck failed (rc=$tc_rc)"; exit "$tc_rc"; fi
if [ "$lint_rc" -ne 0 ]; then echo "::warning::lint failed (rc=$lint_rc) — not blocking"; fi
```

Under `-e`, a **bare** `wait $pid` whose job exited non-zero aborts the step *at
that line*. So neither `tail -50` dump, neither rc check, and neither annotation
was ever reachable on a failing run. Two distinct consequences:

1. **Every cheap-gate failure is diagnostic-free.** The log ends at a bare
   `##[error]Process completed with exit code 1` with no typecheck or lint
   output at all — you cannot tell *which* lane failed, let alone why.
2. **A lint-only failure HARD-FAILS the required check**, directly
   contradicting the `::warning::lint failed (rc=$lint_rc) — not blocking`
   line in the same script. The declared policy is "lint does not block"; the
   observed behaviour was "lint blocks, silently".

### Evidence

PR #3678 run
[30197510215](https://github.com/loopdive/js2/actions/runs/30197510215):
the cheap gate log ends at `Process completed with exit code 1` with **no**
`--- typecheck (last 50 lines) ---` header. The `quality` job on the *identical
tree* reported `lint=1, format=1, typecheck=0` — so typecheck passed and the
abort must have been at `wait $pid_lint`.

## Fix

```bash
tc_rc=0;   wait $pid_tc   || tc_rc=$?
lint_rc=0; wait $pid_lint || lint_rc=$?
```

`cmd || rc=$?` makes the wait a *tested* command, so `errexit` does not fire
while the real exit status is still captured.

**Deliberately NOT `set +e`.** That would disable errexit for the remainder of
the step, and a later edit that stopped propagating `tc_rc` would silently turn
this required gate into a decorative one — a green gate is indistinguishable
from a disabled one. The `|| rc=$?` form keeps propagation explicit and local.

## Is lint still enforced?

**Yes — by the `quality` job, independently.** `.github/workflows/ci.yml`
(lines 122-125) fails on `lint_rc != 0`:

```bash
if [ "$lint_rc" -ne 0 ] || [ "$format_rc" -ne 0 ] || [ "$typecheck_rc" -ne 0 ]; then
  echo "::error::quality lanes failed (lint=..., format=..., typecheck=...)"
  exit 1
fi
```

`quality` is itself a required check, and PR #3678 demonstrated this live: it
carried a real biome `noSelfCompare` error and `quality` failed on it. So
restoring the cheap gate's declared non-blocking behaviour removes **no** lint
enforcement repo-wide — it removes a duplicate, undocumented, diagnostic-free
one.

## Acceptance criteria

- [x] A typecheck error still FAILS the cheap gate (the gate is not neutered)
- [x] A lint-only error PASSES the cheap gate, with `::warning::lint failed`
      visible
- [x] Both `--- typecheck ---` and `--- lint ---` dumps are present on a
      failing run
- [x] Lint remains enforced repo-wide via `quality`

## Test Results

### Local truth table (fixed logic, `bash -e`)

| typecheck | lint | step exit | annotation                | dumps |
| --------- | ---- | --------- | ------------------------- | ----- |
| pass      | pass | 0         | —                         | both  |
| pass      | FAIL | 0         | `::warning::lint failed`  | both  |
| FAIL      | pass | 1         | `::error::typecheck failed` | both  |
| FAIL      | FAIL | 1         | `::error::typecheck failed` | both  |

### Verify-by-reverting (old logic, same harness)

| case             | step exit | dumps        |
| ---------------- | --------- | ------------ |
| lint-only fails  | **1**     | **none**     |
| typecheck fails  | 1         | **none**, no `::error::` |

The bug is present in the old form and absent in the new one, observed in both
directions.

### CI positive control

Two scratch draft PRs off this branch, both carrying the fixed workflow:

- **typecheck-error control** — cheap gate must FAIL, with the typecheck dump
  and `::error::typecheck failed` present.
- **lint-only-error control** — cheap gate must PASS, with
  `::warning::lint failed` and both dumps present.

Results recorded below.
