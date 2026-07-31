---
id: 3880
title: "claim-issue.mjs wedges 10min+ under concurrency and reports success on silent failure"
status: ready
created: 2026-07-31
priority: high
feasibility: medium
horizon: m
task_type: bugfix
area: ci
goal: ci-hardening
sprint: current
related: [2531, 3879]
---

# #3880 — the advisory lock is the fleet's biggest tax, and it fails silently

## Measured, 2026-07-30/31

- **Four agents** lost time to it. One spent **~50 minutes** unable to claim a single
  issue across four attempts (280 s foreground timeouts; one earlier attempt ran
  **10 minutes at 0:00 CPU** before being killed).
- **`--allocate` wedged for three agents.** In at least one case it **threw with
  empty stdout while the caller reported success** — reserving nothing. That is the
  #2531 collision hazard in reverse: a half-reserved id would be green at PR time and
  fail only in the `merge_group`.
- **Two claim releases reported success and silently failed**, leaving stale locks on
  **#3661** and **#3685** that had to be cleared by hand via the contents API.
- **#3420's claim ref is permanently out of sync** — the work merged (PR #3864) while
  the record still shows a different agent's stale entry.

## Root cause

The failure is `cannot lock ref 'refs/remotes/origin/issue-assignments': is at X but
expected Y` — concurrent agents all fetch into the **same shared mirror ref** while
`claim-issue.mjs` is fetching it. The script has **no retry** on this. With several
agents active it is reproducible, not a flake.

The hang is in the first-push-wins retry/backoff loop around the `git push` (~L414).

## The silent-success half is the more dangerous half

Callers wrote `node scripts/... 2>&1 | tail -4; echo "EXIT=$?"` — which reports
**`tail`'s** status, not the script's. Two failed operations therefore looked clean.
The same trap made a pre-dispatch **STOP** print `EXIT=0` earlier the same session.

Any fix must ensure the script's own **exit code is non-zero on failure** and that its
failure is legible without relying on the caller's pipe discipline.

## Fix

1. **Retry with backoff on the ref-lock race** — it is transient and expected under
   concurrency.
2. **Use a per-invocation mirror ref** (or fetch to a temp ref) so concurrent agents
   do not contend on one shared `refs/claim-issue/base`.
3. **Fail loudly**: non-zero exit, an error on stderr, and never an empty-stdout
   throw that a caller can read as success.
4. Document `set -o pipefail` / `${PIPESTATUS[0]}` in the dev protocol — pipe-swallowed
   exit codes bit this repo three times in one session.

## Frequency evidence — one agent, one session, 2026-07-31

A single anecdote is a flake; this is a rate. All from **one** agent's session:

| # | invocation | outcome |
| --- | --- | --- |
| 1 | `claim 3420` | hung ~10 min at 0:00 CPU, killed |
| 2 | `claim 3420` (retry) | died on `cannot lock ref 'refs/claim-issue/base'` — concurrent agent moved the shared mirror |
| 3 | `claim 3420` (foreground) | `timeout 280` exceeded, exit 124 |
| 4 | `claim 3420` (background) | still running after ~15 min; abandoned, work proceeded **unclaimed** on the record's `status: released` |
| 5 | `--allocate` | wedged ~10 min, then **succeeded** → reserved #3885 |
| 6 | `claim 2916 --no-pr-scan` | succeeded (minutes, backgrounded) |

**Four wedges plus two slow successes in one session**, each stall in the
5–15 minute range. Two other agents were observed in the same state concurrently
(`3661`, `3672`, `3655`), so it is fleet-wide contention rather than one bad
checkout.

**The concrete cost:** #3420 was implemented and merged with **no claim record
ever taken** — the protection this tool exists to provide was simply absent for
that task, and the only thing preventing duplicate work was a human noticing.

The shared `refs/claim-issue/base` mirror is implicated: every agent fetches
into the *same* ref, so N concurrent claims contend on one lock. Failure 2 is
that collision surfacing directly.

## Why priority high

The lock is **advisory**. A standing instruction now says an advisory lock that
cannot be acquired in a few minutes must not stop work — verify the record's `status`
directly and proceed. But that is a workaround: the lock exists to prevent duplicate
dispatch, and while it is wedged the fleet is running without that protection.

And the workaround has a sharp edge: "proceed if the record says `released`"
is only safe because the *reader* path works. If a wedge ever produced a stale
**read**, two agents could both see `released` and both start.

## Acceptance

- Concurrent claims from 4+ agents succeed within seconds, or fail fast with a
  non-zero exit and a legible error.
- A failed release/allocate can never be mistaken for success by its caller.
- `--allocate` either reserves an id or exits non-zero — never both nothing and 0.
