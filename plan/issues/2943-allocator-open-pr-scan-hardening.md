---
id: 2943
title: "tooling: claim-issue --allocate open-PR scan missed in-flight issue files (silent gh-failure fan-out) — batch, retry, fail-loud"
status: done
completed: 2026-07-02
assignee: ttraenkler/dev-f2
created: 2026-07-02
updated: 2026-07-03
priority: low
sprint: 69
horizon: s
task_type: bug
area: tooling
goal: developer-experience
related: [2531, 1858]
origin: "2026-07-02 tech-lead task #14 from the 2920/2921 allocation collisions."
---

# #2943 — `--allocate` open-PR scan: silent fan-out failures narrow the id universe

## Problem

Concrete repro: 2026-07-02 ~00:30Z, `claim-issue.mjs --allocate` returned
**2920** although open PR loopdive/js2#2424 (created 23:07Z) already added
`plan/issues/2920-strict-negative-verdict-succeeded-arm.md`. Same pattern hit
**2921** (PR #2425). Downstream cost: one analysis file burned the
2921→2931→2937→**2940** re-id chain across parallel-session collisions.

## Root cause (investigated, not pagination)

PR #2424 has only 9 changed files and today's scan sees it — so the miss was
NOT the 100-file cap or PR-list pagination. The old scan fanned out **1 + N
`gh` calls** (`gh pr list`, then `gh pr view --json files` per open PR) and
swallowed every failure silently (`catch { /* skip this PR */ }`, and a full
list failure returned an empty set). Under gh rate-limit / API contention
(7+ concurrent agents, each with CI watchers polling `gh`), any dropped call
narrowed the id universe with **no signal** — `--allocate` then computed
max+1 over a universe missing in-flight files. (A second latent miss source:
`gh pr view --json files` silently truncates at 100 files.)

## Fix

`scripts/claim-issue.mjs`:

1. **One batched GraphQL query** (100 PRs × 100 files per page, cursor
   pagination) replaces the fan-out — ~2 orders of magnitude fewer API calls,
   one failure point instead of N.
2. **REST `--paginate` fallback** fetches the full file list for the rare
   > 100-file PR (`files.pageInfo.hasNextPage`).
3. **3× retry with backoff** around the whole scan.
4. **Fail-LOUD degraded mode**: on persistent failure the scan returns
   `complete:false`; `--allocate` prints a prominent stderr warning and the
   `--json` output carries `prScanDegraded:true`. Still fail-open by design
   (offline/unauthenticated use keeps working; the CI gate
   `check-issue-ids --against-main` remains the hard backstop) — but never
   fail-silent again.
5. **`--debug-pr-scan` mode** prints `{ids,complete}` for diagnosis and tests.

## Test Results

`tests/issue-2943.test.ts` (4/4) drives `--debug-pr-scan` through a
PATH-injected fake `gh`: batched-query parsing, >100-file REST fallback,
persistent-failure → `complete:false`, transient-failure → retry succeeds.
Live check: scan sees all in-flight PR ids (2896…2941), `--dry-run` proposes
the correct next id.
