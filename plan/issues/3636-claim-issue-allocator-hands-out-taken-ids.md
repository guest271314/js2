---
id: 3636
title: "claim-issue.mjs --allocate hands out already-taken ids, even WITH the full PR scan"
status: ready
created: 2026-07-25
priority: high
horizon: s
feasibility: medium
area: tooling
goal: ci-hardening
related: [2531, 1616]
---

# #3636 — the id allocator hands out taken ids

## Five collisions in one sprint

| # | shape | detail |
|---|---|---|
| 1 | cross-lane | `--allocate` gave 3585; another lane landed `3585-*` on main mid-flight → renumbered to 3592 |
| 2 | **self**-collision | one agent filing two issues in quick succession got **3589 twice** → parked PR #3581 on the #1616 integrity gate |
| 3 | main-vs-PR | PR #3614 introduces `3620-*` while main already has a different `3620-*` |
| 4 | cross-lane, **full scan enabled** | `--allocate` **with** the PR scan returned **3619**, already used by open PR #3614; **3620 and 3621 likewise taken** (#3614/#3615) → renumbered to 3622 |
| 5 | main-vs-PR | PR #3627 adds `3630-*` after PR #3626 merged a different `3630-*` |

## The regression

The earlier working theory was that `--no-pr-scan` was the proximate cause — one agent's
*both* collisions came from it, while every full-scan allocation held. **Case 4 refutes
that**: the full scan returned an id already used by an open PR, and the next two were
taken as well.

So the open-PR half of the scan is **not reliably seeing in-flight ids**. That is the bug.

## Why each one is expensive

The collision is invisible at PR level and only fails in the **`merge_group`** — via
`check:issue-ids:against-main` (id already on main) or the **Issue integrity + link gate
(#1616)** (two files with the same id in one tree). Both live in `quality`. So a green PR
gets parked later, costing a full CI round-trip plus a manual diagnosis each time.

**Note the two distinct gates** — don't pattern-match on one; case 2 hit #1616, case 3 hits
`against-main`.

## Investigate

1. Does the open-PR scan paginate? At the current PR volume an unpaginated first page would
   silently miss in-flight ids — that shape would explain case 4 exactly.
2. Is there a caching or a stale-fetch step between the scan and the reservation?
3. Does the reservation on the orphan `issue-assignments` ref propagate fast enough for a
   second `--allocate` seconds later? Case 2 (self-collision) suggests not.

## Guard rails to add regardless of root cause

- **Verify-after-allocate**: re-check the returned id against `main` ∪ open PRs ∪ the
  assignments ref immediately before writing files, and fail loudly on a hit.
- **Renumbering is itself a trap**: a `git mv` that leaves the in-file `id:` unstaged
  produced a *re-collision* this sprint. The only signal was gh's
  `Warning: 1 uncommitted change` on `pr create`. After any renumber, **grep the whole
  change-set for the old id and require zero hits** — filename, `id:` frontmatter, heading,
  cross-refs, test names, PR title, and rationale comments in code.
- **Verify the incumbent with `git ls-tree origin/main`, not by assumption.** The lead
  asserted which of two same-id files was already on main and had it exactly inverted.

## NOT the same issue

#3602 is `compile-timeout dstr-iter family` — unrelated. It was mis-cited as covering this
class; it does not.
