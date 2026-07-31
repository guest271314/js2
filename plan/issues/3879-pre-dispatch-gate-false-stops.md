---
id: 3879
title: "pre-dispatch-gate: released/done claims read as live STOPs, and PRs that MODIFY an issue file are invisible"
status: ready
created: 2026-07-31
priority: high
feasibility: easy
horizon: s
task_type: bugfix
area: ci
goal: ci-hardening
sprint: current
related: [2531, 3800]
---

# #3879 — two independent blind spots, both measured against live records

## Defect 1 — the claim check ignores `status`

`scripts/pre-dispatch-gate.mjs` (~L127-134) pushes a BLOCKER for **any** claim record
carrying an `assignee`, and never reads `c.status`. A released or completed claim
keeps its `assignee` for provenance, so **it reads as a live lock**.

Verified against the real records on `origin/issue-assignments`:

| id | record | gate says |
|---|---|---|
| **3420** | `"status": "released"`, released 2026-07-23T23:38:57Z (4 min after claiming) | CLAIMED — **false STOP** |
| **2742** | `"status": "done"`, released 2026-06-27 | CLAIMED — **false STOP** |
| 3776 | `"status": "in-progress"` | CLAIMED — correct |

**Two of four "hard claims" in one lane were stale.** Devs are being turned away from
available work; #3420 was blocked by this and turned out to be a real, landable fix
(now merged as PR #3864).

Fix:
```js
const DEAD_CLAIM = ["released", "done", "wont-fix", "abandoned"];
if (c.assignee && !DEAD_CLAIM.includes(c.status)) { /* blocker */ }
```

## Defect 2 — open-PR scan only sees ADDED issue files

The gate scans open PRs for **added** `plan/issues/<id>-*.md` files. **PR #3687
only *modifies* #3654/#3655/#3672** — so it was completely invisible to the gate,
and `pre-dispatch-gate.mjs 3654` returned CAUTION without surfacing the open PR that
implements it. That is a whole class of missed collision: any long-lived branch that
edits rather than creates an issue file.

## Defect 3 (enhancement) — a merged `type(#N):` commit is a strong "already done" signal

The gate prints commits mentioning `#N` as a mere **warning**. A merged commit whose
subject carries a conventional-commit prefix **other than `docs(`** — e.g.
`perf(#3688): …` — is a much stronger "already implemented" signal and should
escalate. #3688 was dispatched as live work while `8b4d74f1 perf(#3688): …` was
already an ancestor of main, with 18 test pins.

## Why these matter together

All three cause the same outcome from opposite directions: **an agent is either sent
at work that is already done, or turned away from work that is available.** Both waste
a full measurement cycle, and both happened repeatedly on 2026-07-30/31.

## Acceptance

- A `released`/`done` claim record does not produce a BLOCKER.
- A PR that *modifies* an issue file is surfaced by the open-PR scan.
- A merged non-`docs` `type(#N):` commit on main escalates above a warning.
- Re-running the gate on #3420 and #2742 returns clear, and on #3654 surfaces #3687.
