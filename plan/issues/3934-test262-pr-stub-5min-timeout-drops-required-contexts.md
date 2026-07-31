---
id: 3934
title: "`test262 PR stub` times out at 5 min and REQUIRED contexts go missing — a PR then waits on checks that will never report"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: s
feasibility: easy
task_type: ci
area: ci, merge-queue
goal: ci-hardening
related: [3878, 3908, 3880, 3584]
origin: "Cluster spotted by shepherd-2 across four PRs on 2026-07-31; mechanism pinned while unparking #3907. The logs name no cause because GitHub reports a job timeout as `cancelled`."
---

# #3934 — the test262 PR stub times out at 5 min, and takes required contexts with it

## The mechanism

`.github/workflows/test262-pr-stub.yml`:

```yaml
  detect:
    name: test262 PR stub — detect relevance
    timeout-minutes: 5
```

When the job exceeds that budget GitHub **kills it and reports the conclusion as
`cancelled`** — not `failure`, and not `timed_out` in the check-run surface. The job log
contains exactly one line of explanation:

```
##[error]The operation was canceled.
```

**That is why no log names a cause and why this reads as a concurrency cancellation.** It
is not one. It is the 5-minute budget being hit.

## THE PART THAT MAKES THIS URGENT — required contexts go MISSING, not red

This is the consequence that is not recorded anywhere else, and it is strictly worse than
a red check.

The stub is not cosmetic. For a PR with no test262-relevant changes it **supplies** the
required contexts as stub-passes:

| context | required? | supplied by |
| --- | --- | --- |
| `cheap gate (main-ancestor + lint)` | **yes** | `test262-pr-stub.yml` (stub-pass job) |
| `merge shard reports` | **yes** | `test262-pr-stub.yml` (stub-pass job) |
| `check for test262 regressions` | **yes** | `test262-pr-stub.yml` (stub-pass job) |

Those jobs are gated on `detect`'s output. When `detect` times out they never run, so the
required contexts are **absent** rather than non-green.

**A missing required context never resolves.** A red check can be re-run or fixed and the
PR moves; an absent one leaves the PR waiting on something that will never report, with
nothing in the UI naming what is missing. `auto-enqueue` also accepts only
`{CLEAN, HAS_HOOKS}`, so the PR is skipped indefinitely.

## The cluster

Four occurrences on four different PRs, all on 2026-07-31 — reported by `shepherd-2`,
who read the clustering of durations as "a hard timeout, not a slow fetch":

| PR | duration |
| --- | --- |
| #3904 | 4m55s |
| #3900 | 4m58s |
| #3901 | 5m0s |
| #3907 | 5m1s |

**Verified independently, with a caveat that matters for anyone re-checking this.** A
census of `check-runs` on 2026-07-31T16:5xZ reproduced **#3900 `cancelled` at 5m3s** and
**#3907 `cancelled` at 5m1s** (observed live before remediation), but showed #3901 and
#3904 as `success`.

**That is not a contradiction — it is the instrument.** Re-running a job **overwrites**
its check-run record, so a census taken *after* anyone has remediated under-counts the
cluster. Both PRs had been re-run by then. **Do not use a post-hoc `check-runs` census to
size this defect**; it can only ever show the occurrences nobody has fixed yet.

## It is a FLAKE, not a systematically slow job — the sharpest evidence

On #3907, commit `02d2b5d4`:

| run | duration | conclusion |
| --- | --- | --- |
| original | **5m1s** | `cancelled` (timeout) |
| re-run, **identical SHA** | **0m40s** | `success` |

Same commit, same tree, same fetch — 7.5× difference and opposite outcomes. Typical
duration across the sampled runs is **36s–50s**, so the timeout case is ~7–8× normal
rather than a gradual creep.

**Operational consequence:** a re-run is a valid remediation for an occurrence (it is
remediating a flake, not changing the change). It is not a fix.

## Likely cause — ref count

Measured 2026-07-31: `git ls-remote origin` returns **6,145 refs** (1,985 heads, 235 tags,
the remainder `refs/pull/*`). During the #3880 work a full-ref fetch was measured with a
**47.8 s connectivity check** on this repo.

A 5-minute budget for checkout-plus-path-match is tight against that ref count, and it
explains the flakiness: the job is normally ~40 s, but a fetch that has to walk every ref
can blow past 5 minutes when the runner or the connectivity check is slow.

**So the fix is plausibly both halves:**

1. **Raise the budget** — `timeout-minutes: 5` has no headroom over a known 47.8 s
   connectivity check plus checkout. This is the one-line mitigation.
2. **Narrow the fetch** — the `detect` job only needs the changed-path list. A shallow,
   single-ref, blob-filtered checkout (`fetch-depth`, `filter=blob:none`, and *not* a
   full-ref/full-tag fetch) removes the cost centre rather than budgeting around it.

Raising the budget alone leaves a job that occasionally takes minutes for a path match.

## Third arrival route into the #3878 / #3908 stranding class

The same end state — **a PR that is green on the merits and never enqueues** — has now
been reached three different ways:

| # | route | mechanism |
| --- | --- | --- |
| 1 | **#3878** | a helper (`release-pending`) wrong for every fork head ⇒ red non-required ⇒ `UNSTABLE` |
| 2 | **#3889** | a non-required check finishing *last* with no `workflow_run` trigger ⇒ `CLEAN` but unswept |
| 3 | **this** | a flaky timeout on a **context-supplying** check ⇒ required contexts **missing** |

Route 3 is the worst of the three, because the other two leave a signal — a red check, or
a `CLEAN` PR a sweep can pick up. This one leaves a PR whose required contexts simply
never arrive.

**#3908's protocol fix (stand down only on `CLEAN`, not on "required checks green") is
necessary and does not cover this.** It stops a dev *standing down* onto the stranding
condition; it does not stop the stranding. Both are needed.

## Acceptance

1. A test262-irrelevant PR reliably gets all three stub-supplied required contexts
   reported — no run of `detect` is `cancelled` by timeout across a sustained window.
2. `detect`'s normal duration stays in the tens of seconds, and the budget has clear
   headroom above the worst observed fetch.
3. If the fetch is narrowed, `detect` still produces the same relevance verdict — the
   `&test262-paths` allowlist mirroring must not regress, or the stub and the real
   `test262-sharded.yml` could both claim, or both drop, a required context.

## Notes

- **Do not "fix" this by making the stub jobs unconditional.** They must stay mutually
  exclusive with `test262-sharded.yml`'s real jobs — the header comment in
  `test262-pr-stub.yml` is explicit that the two workflows can never both own a required
  context on the same PR.
- The `concurrency` group (`test262-pr-stub-<pr>`, `cancel-in-progress: true`) is a
  *different* source of `cancelled` on this same job. When triaging, separate the two by
  **duration**: a concurrency cancel happens whenever a newer push lands; a timeout sits
  at ~5m00s. Both surface identically in the check-run conclusion.
