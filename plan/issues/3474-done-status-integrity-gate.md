---
id: 3474
title: "Done-status integrity: complete the false-done triage + add a CI gate blocking status:done while an issue has live test262 citations"
status: ready
sprint: current
priority: high
task_type: infrastructure
related: [2093, 2961, 1472, 2026, 680, 2046]
---

## Problem

A 2026-07-20 harvest cross-reference found a **systemic false-`done` problem**:
**16 issues marked `status: done` still have ≥15 live test262 failures citing
their `#NNNN` in the error field.** The `done` status is unreliable — the top
failure causes are nearly all marked done while their tests still fail.

Already reopened (PR #3427): #2026 (2,924 live), #1472 (958), #680 (398).

## Scope — two parts

### Part A — complete the false-`done` triage
Triage the remaining `done`-with-live-citations candidates and reopen the genuine
ones (set `status: ready`, cite the live count). Distinguish **genuine
false-done** (feature meant to work, still fails) from **legitimate
done-but-cited** (a detector/umbrella like #2961, or an intentional refusal like
#1387 with-statement / #1696 dynamic-import — citations are the expected "we
refuse this").

Candidates to triage (17–61 live each): **#1907, #1888, #221, #2620, #2717,
#2043, #258, #222, #223, #230**. Re-run the audit for the full list:
extract error-field `#NNNN` from failing records in both baselines-repo lanes,
join against `plan/issues/*.md` status, flag `done` + citations > threshold.

### Part B — CI gate (the durable fix)
Add a gate (wire into `quality`, sibling to the #2093 probe gate) that **fails a
PR flipping an issue to `status: done` (or leaving it done) when that issue's
`#NNNN` still has more than N live citations** in the current baselines-repo
JSONL (both lanes). Provide an explicit exemption for detector/umbrella/deferred
issues (e.g. a `done_cited_ok: true` frontmatter flag or a `task_type` allowlist)
so #2961/#1387/#1696-class issues don't trip it. This makes done-status
self-correcting instead of drifting.

## Acceptance criteria
- All genuine false-`done` issues among the candidates reopened; legitimate
  done-but-cited issues left done, with the exemption flag applied.
- CI gate present and green on main; a deliberately-mislabeled test issue fails it.
- Exemption mechanism documented.

## Notes
- Audit method + evidence: the sprint-73 harvest (error-field `#NNNN` extraction,
  both lanes) and #3427 (the first three reopenings).
