---
id: 3596
title: "#3189 trap ratchet has no per-PR valve for a genuine fail→fail reclassification"
status: done
completed: 2026-07-24
sprint: current
created: 2026-07-24
updated: 2026-07-24
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci, merge-queue
goal: release-pipeline
related: [3189, 3303, 3370, 3202, 3563, 3583, 3593]
origin: "PR-queue shepherd, 2026-07-24. Two net-positive PRs auto-parked on a +1 trap in one evening with no available valve."
---

# #3596 — a per-PR, machine-checked valve for the #3189 uncatchable-trap ratchet

## Problem

The #3189 ratchet is a strict "traps may only shrink" gate. That is exactly right
for a **regression** — a test that used to `pass` and now traps. It is wrong for
a **reclassification** — a test that _already failed_ and merely changed the
**flavour** of its failure, which is what happens when a fix makes a module
compile far enough to reach a **pre-existing latent trap**.

The ratchet cannot tell those apart, so it parks the second case as if it were
the first. Measured cost on a single evening (2026-07-24):

| PR    | net          | ratchet delta               | outcome |
| ----- | ------------ | --------------------------- | ------- |
| #3563 | **+11 pass** | `null_deref` 159 → 160 (+1) | parked  |
| #3583 | **+16 pass** | `unreachable` 2 → 3 (+1)    | parked  |

Both were **fail → fail** flavour changes on tests that had never passed
(#3563's case is root-caused in #3593: a latent null-deref in the compiled
test262 `assert` harness, which traps identically with and without the PR's
change). Both were blocked. Neither had any way through.

## Why the existing levers did not work

- **`TRAP_RATCHET_TOLERANCE`** (#3202) is a **repo-level Actions variable**. It
  is global and time-based: while open it blinds the ratchet for _every_ PR in
  the queue, not just the declaring one. The repo has a prior incident of it
  being left open — which is why
  `.github/workflows/trap-tolerance-staleness-alert.yml` exists. Using it to
  land one PR trades a queue-wide blind spot for a single merge.
- **`trap-growth-allow:`** (#3370) is the _right shape_ — change-scoped,
  declared in the granting issue's own frontmatter, consumed once — but its read
  in `scripts/diff-test262.ts` was wrapped in `if (rebaseMode)`, so it was
  **inert for an ordinary same-oracle PR**. It only ever applied to a deliberate
  oracle re-baseline.

So the gap was narrow and specific: the mechanism existed, it just could not be
reached from the case that needed it.

## Fix — extend the existing mechanism, machine-checked

`trap-growth-allow:` is now read in **both** modes. Rebase mode behaves exactly
as #3370 defined it. On an ordinary non-rebase PR the allowance is honoured only
if the declaration **names the reclassified tests** and every claim verifies
against the baseline.

```yaml
trap-growth-allow:
  count: 1
  reason: "pre-existing assert-harness null-deref, unmasked not caused (#3593)"
  tests:
    - test/built-ins/Iterator/zip/iterables-iteration.js
```

`evaluateTrapReclassification` (pure, unit-tested) enforces three conditions,
all required:

1. **Named** — a bare `count:` is refused outside a re-baseline. An uncheckable
   claim is not a valid declaration.
2. **Not previously passing** — every named test must have a baseline row whose
   status is **not `pass`**. **A `pass → trap` transition still hard-fails.**
   This is the property that stops the valve from becoming an escape hatch. An
   absent baseline row is also refused: it proves nothing either way.
3. **Complete** — every file actually responsible for the growth must be named.
   Undeclared growth — including growth in a category the PR never mentioned —
   fails, so a `count: 1` cannot quietly excuse an unrelated new trap elsewhere.

Every pre-existing containment property is preserved: per-category, positive
integer, mandatory reason, declared in the granting issue's frontmatter,
change-set scoped (an allowance that lands on `main` grants nothing to later
PRs), ceiling-not-blank-cheque, and declarations do not sum.

## Changes

- `scripts/lib/change-scope.mjs` — `parseFrontmatterCountReason` gained an
  **optional** nested `tests:` list (block and inline form). Legacy
  `count:`/`reason:` declarations parse unchanged and report `tests: []`.
- `scripts/diff-test262.ts` — `RegressionsAllowance.tests`; new exported pure
  `evaluateTrapReclassification`; the allowance read is no longer
  `rebaseMode`-gated; the check runs only when the allowance actually excused
  something (`maxGrowth > 0`), so a declaration that excused nothing never fails
  a PR.
- `tests/issue-3596-trap-growth-allow-nonrebase.test.ts` — 11 new tests.
- `tests/issue-3303.test.ts` — the `#3370` "inert without an oracle bump" case
  **superseded**, see below.

### One intentionally-changed existing test

`tests/issue-3303.test.ts` → _"keeps trap-growth-allow inert without an oracle
bump (#3370)"_. The **property** it protected is unchanged and still asserted: a
bare `count:`/`reason:` declaration grants nothing on a same-oracle PR, and the
PR is still blocked with exit status 1. Only the **mechanism** changed — the
declaration is now read and then _refused for being uncheckable_, rather than
never being read — so the assertion on the specific failure message was updated
and the test renamed to `a bare trap-growth-allow still grants nothing without an
oracle bump (#3370/#3596)`. Two CLI-level companions were added alongside it: one
proving a named-but-previously-**passing** test is refused, one proving a genuine
named `fail → trap` reclassification is honoured.

## Acceptance criteria

- [x] A non-rebase PR can declare a bounded, named `trap-growth-allow` and pass.
- [x] A `pass → trap` transition still hard-fails, even when named and within the
      declared ceiling.
- [x] Undeclared trap growth still hard-fails.
- [x] A bare count on a non-rebase PR is refused with an actionable message.
- [x] Rebase-mode (#3370) behaviour is unchanged; legacy declarations still parse.
- [x] `TRAP_RATCHET_TOLERANCE` was **not** touched.

## Notes

- ⚠️ **Tooling trap:** plain `grep` returns **nothing** on
  `scripts/diff-test262.ts` — it silently treats the file as binary despite
  `file` reporting clean UTF-8. `grep -n "trap" scripts/diff-test262.ts` exits 1
  and reads as a confident "not present". **Use `grep -a`.** This produced a
  wrong conclusion about the valve's existence once during this very
  investigation.
- Follow-up: #3563 and #3583 can each now declare their bounded +1 with a
  rationale and come off `hold`.
