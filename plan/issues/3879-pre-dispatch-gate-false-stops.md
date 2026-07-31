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

| id       | record                                                                       | gate says                |
| -------- | ---------------------------------------------------------------------------- | ------------------------ |
| **3420** | `"status": "released"`, released 2026-07-23T23:38:57Z (4 min after claiming) | CLAIMED — **false STOP** |
| **2742** | `"status": "done"`, released 2026-06-27                                      | CLAIMED — **false STOP** |
| 3776     | `"status": "in-progress"`                                                    | CLAIMED — correct        |

**Two of four "hard claims" in one lane were stale.** Devs are being turned away from
available work; #3420 was blocked by this and turned out to be a real, landable fix
(now merged as PR #3864).

Fix:

```js
const DEAD_CLAIM = ["released", "done", "wont-fix", "abandoned"];
if (c.assignee && !DEAD_CLAIM.includes(c.status)) {
  /* blocker */
}
```

## Defect 2 — open-PR scan only sees ADDED issue files

The gate scans open PRs for **added** `plan/issues/<id>-*.md` files. **PR #3687
only _modifies_ #3654/#3655/#3672** — so it was completely invisible to the gate,
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
- A PR that _modifies_ an issue file is surfaced by the open-PR scan.
- A merged non-`docs` `type(#N):` commit on main escalates above a warning.
- Re-running the gate on #3420 and #2742 returns clear, and on #3654 surfaces #3687.

## Coverage gap: the gate cannot catch a duplicate filed under a NEW id

Distinct from the false-STOP failures above — this is a **false-CLEAR**, and it
is structural rather than a tuning problem.

**Worked example (2026-07-31).** An agent measured a `String.prototype`
`ToString(this)` generic-receiver defect, allocated **#3877** via
`claim-issue.mjs --allocate`, ran `pre-dispatch-gate.mjs 3877`, and got **CLEAR**.
It filed the issue and opened a PR. **#2742** — _"String.prototype methods:
ToString(this) generic-receiver coercion, RequireObjectCoercible, and function
`.length` own property"_ — already described exactly that defect, was three days
older, `priority: high`, `sprint: current`, and its `func-budget-allow` already
named `src/codegen/string-ops.ts::compileNativeStringMethodCall`, the same code.
#3877 is now `wont-fix / duplicate_of: 2742`.

**The gate could not have caught it.** Run on a freshly allocated id it finds
nothing _by construction_: there are no commits mentioning it, no PRs, no claim
record, no issue file on main, and the idiom scan has no local file to read terms
from. Every check returns empty, and empty reads as CLEAR. Compare
`pre-dispatch-gate.mjs 2742`, which correctly reports **STOP — CLAIMED**: the
gate works perfectly on an id that exists and is blind by construction on one
that does not.

**Rule:** _search existing issues for the SYMPTOM before allocating an id, not
the id after allocating it._ A `grep -ril "<distinctive symptom phrase>"
plan/issues/` costs one command. In this case
`grep -ril "ToString(this)" plan/issues/` would have surfaced #2742 immediately.

**Possible mechanisation** (cheapest first):

1. `claim-issue.mjs --allocate` prints the top title/term matches against
   existing `plan/issues/*.md` for a `--like "<phrase>"` argument, and requires
   `--force` to reserve when strong matches exist.
2. The gate warns when invoked on an id with **no local issue file and no trace
   anywhere** — today the most suspicious input produces the most reassuring
   output.
3. `check-issue-spec-coverage.mjs` (or a sibling) flags a newly ADDED issue file
   whose distinctive title terms overlap heavily with an existing `ready` issue.

**Why this matters more than an ordinary duplicate:** the duplicate is filed with
full confidence _because_ the gate returned CLEAR. The tool designed to prevent
duplicate dispatch actively reassured the agent while it created one.
