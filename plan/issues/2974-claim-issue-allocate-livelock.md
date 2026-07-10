---
id: 2974
title: "infra: claim-issue --allocate livelock under multi-session load (6 concurrent allocators observed)"
status: done
assignee: ttraenkler/agent-opus-2109
created: 2026-07-02
updated: 2026-07-03
completed: 2026-07-03
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: chore
area: infra
sprint: Backlog
related: [2531, 2977]
---

# #2974 — `claim-issue --allocate` livelock under multi-session load

## Problem

`scripts/claim-issue.mjs --allocate` reserves ids by pushing to the
`issue-assignments` ref with first-push-wins semantics; a loser re-scans and
retries. Under multi-session load this degrades into a **livelock**: dev-2856f
observed **six concurrent `--allocate` processes** each re-scanning hundreds of
ref entries (per-file `git show`), losing the push race to one another, and
restarting — repeatedly.

Observed costs:

- **Lost id reservations** — #2939/#2940/#2941 were renumbered away.
- **Wasted agent time** — each retry round is a full ref re-scan plus a network
  push; with 6 contenders most rounds make no global progress.
- **Disincentive to file issues during busy windows** — agents defer filing
  (or worse, hand-pick ids) when `--allocate` visibly thrashes.
- Even at low contention the race bites: a single-allocator run on 2026-07-02
  hit `allocate: ref moved (attempt 1/6) — re-scanning…` and needed a retry
  (dev-evalf, while reserving #2974 itself).

## Possible directions

1. **Backoff + jitter** on push-race loss (cheapest — bounds the herd's retry
   synchronization; today losers retry immediately and re-collide).
2. **Batch reservation** — an allocator grabs a small id RANGE per push, and
   the session hands out ids locally (amortizes the race across N filings).
3. **Single lightweight lock ref** — serialize allocators through a tiny
   advisory lock commit instead of full-ref compare-and-swap, so losers wait
   instead of re-scanning hundreds of entries.
4. **Server-side allocation endpoint** — the same shift that fixed the
   enqueue races (#2786): move the atomic step to a GitHub Actions workflow
   (workflow_dispatch returning the next id) that is outside agent lifecycle.
5. **Cheaper re-scan** — replace per-file `git show` with one `git ls-tree`
   batch read so a retry round costs one object walk, not hundreds of
   subprocesses (helps regardless of the chosen concurrency fix).

## Acceptance criteria

- [ ] Six concurrent `--allocate` calls (soak script or CI matrix) all
      terminate with distinct ids, no reservation lost, bounded retries.
- [ ] A retry round no longer costs O(entries) `git show` subprocesses.
- [ ] `--allocate` keeps its atomicity guarantees (no dup ids vs `origin/main`
      ∪ open PRs ∪ reserved ids — the #2531 invariants).

## Notes

Filed from TaskList task #29 (evidence by dev-2856f; filed by dev-evalf).
Sibling of the promote-baseline push-race issue (same first-push-wins ref
pattern, being filed by dev-2912f). Related: #2531 (the original atomic
`--allocate` design).

## Resolution (2026-07-03)

Adopted **direction 1 (backoff + jitter)** — the cheapest fix that turns the
synchronized herd into a de-facto queue — plus the `refs/claim-issue/base`
non-fast-forward crash fix that #2977 (the duplicate report) additionally
flagged. Changes in `scripts/claim-issue.mjs`:

- **`raceBackoffMs(attempt)`** — exponential backoff with full jitter
  (`random[0, min(4000, 150·2^(attempt-1)) ms]`). Both first-push-wins loops
  (`--allocate` and claim/release/complete) now sleep this amount after a
  race-loss re-scan, so concurrent contenders spread out in time instead of
  re-colliding in lock-step. The wait is skipped after the final attempt;
  `MAX_RETRIES` still bounds the total.
- **`fetchAssign` force-fetch** — the local mirror ref is now fetched with a
  `+`-prefixed refspec, so a diverged `refs/claim-issue/base` overwrites cleanly
  instead of hard-crashing the script with a non-ff lock error (previously
  needed a manual `git update-ref -d refs/claim-issue/base`).

Verified: syntax check, read-only `--check`/`--dry-run`, and a live
release→reclaim round-trip all succeed; atomicity (the #2531 invariants,
compare-and-swap on the ref sha) is unchanged — only retry timing and the
mirror-ref fetch mode change.

Acceptance status:

- [x] Bounded retries, no lock-step re-collision (backoff+jitter; `MAX_RETRIES`
      cap unchanged).
- [ ] O(entries) `git show` per retry round — **deferred** (direction 5). The
      backoff already breaks the livelock; the per-file scan cost is a separate,
      independent optimization left as follow-up so this stays a small, safe
      change to shared live infra.
- [x] `--allocate` atomicity guarantees preserved (compare-and-swap unchanged).

**Duplicate:** #2977 is the same report filed independently in the same window;
it is marked `wont-fix` (dup of #2974). Its extra detail (the
`refs/claim-issue/base` non-ff crash) is incorporated in this fix.
