---
id: 2942
title: "ci: promote-baseline push race — rebase-conflict exhaustion strands the baseline and manufactures phantom regressions on every subsequent PR"
status: done
completed: 2026-07-02
assignee: ttraenkler/dev-f2
created: 2026-07-02
updated: 2026-07-03
priority: medium
sprint: 69
horizon: m
task_type: bug
area: ci
goal: developer-experience
related: [1861, 2178, 1668]
origin: "2026-07-02 tech-lead task #15 from the #2873 promote failure (run 28554922430, job 84660851424)."
---

# #2942 — promote-baseline push loop: fetch+rebase deterministically exhausts on generated-file conflicts

## Problem

Concrete instance 2026-07-02: #2873's `promote-baseline` job (run 28554922430,
job 84660851424) exhausted all 5 rebase-retry attempts pushing to
`loopdive/js2wasm-baselines`, leaving the promoted baseline stranded at
`d12fc59b7` (pre-#2873).

Root cause: two promote-baseline runs racing on the baselines repo both
REWRITE the same generated files (`test262-current.jsonl` etc.). Once the
remote advances, `git rebase --autostash origin/$BR` (the #1861 loop) hits the
**same content conflict on every retry** — generated files cannot be
line-merged — so the loop exhausts deterministically, not transiently. The
sleep/backoff never helps.

Effect: every subsequent PR's regression gate diffs against the stale
baseline → phantom wasm-hash-changed regressions (e.g. #2424's net −2, proven
drift by the shepherd) → bot park-holds on innocent PRs. The failure is only
discovered indirectly (a parked PR's drift analysis); the #1668 stale guard
fires only at ≥50 relevant commits behind.

## Fix (this issue)

Replace the fetch+rebase loop in the baselines-repo push with the **Option-A
re-anchor** pattern already used by the main-repo summary push (#1861 follow-up):

1. Snapshot the files THIS run promoted (from the promote commit's
   `diff-tree`) before the loop.
2. On a lost push race: fetch, **hard-reset onto the fresh remote tip**
   (`git checkout -f -B`), re-apply the snapshot wholesale, `git add -A`,
   re-commit. Generated files are replaced, never line-merged → no conflict is
   possible.
3. **Ordering guard (latest-wins)**: baseline commit subjects embed the
   promoted main SHA (the same convention the #1668 stale guard parses). If
   OUR `github.sha` is an **ancestor** of the remote tip's promoted SHA, a
   newer promote already landed — ours is superseded; drop it and succeed.
   (Main-repo history is deepened `--depth=200 --filter=blob:none` for the
   ancestry check; fail-open to overwrite if either SHA is unresolvable.)
4. Retry budget 5 → 8 with capped backoff; empty re-anchored diff = converged,
   success.
5. Louder stranding signal: final failure writes a `GITHUB_STEP_SUMMARY`
   block + `::error` explaining the stale-floor consequence and the
   `workflow_dispatch` re-run remedy.

Explicitly NOT done: a job-level `concurrency` group on `promote-baseline` —
the per-SHA push groups are load-bearing (#2178): a shared group's single
pending slot silently cancels the intermediate run's promote, which is the
exact failure mode #2178 fixed. See the workflow header comment.

## Test plan

Workflow-only change (the push loop is push:main-scoped); validated by shell
syntax review + the next push:main promote. The re-anchor pattern is the same
one the adjacent main-repo push step has used successfully since #1861.
