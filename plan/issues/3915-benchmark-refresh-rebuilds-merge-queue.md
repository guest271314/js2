---
id: 3915
title: "benchmark-refresh pushes to main discard in-flight merge_group validations"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
goal: release-pipeline
---

# benchmark-refresh pushes to main discard in-flight merge_group validations

## Summary

`benchmark-refresh.yml` pushes a `chore(ci): refresh landing benchmark artifacts [skip ci]`
commit **directly to `main`** after every merge. Any push to `main` forces the merge queue to
**rebuild its group on the new base**, which **discards the in-flight `merge_group` validation**
— including validations that had already gone **fully green**.

Because the bot push is *triggered by* each merge and lands **7–12 min later**, while the next
PR's group is built within seconds of that merge and takes **11–13 min** to validate, **every
merge schedules a bot push timed to land inside the next merge's validation window.**

This is not a bot that occasionally collides with the queue. It is a **feedback loop**, and its
corollary is the alarming part:

> **The tax scales with merge throughput — the busier the queue, the more validation is discarded.**

That is backwards for a pipeline whose job is to land work.

## Measured impact

**Window:** 2026-07-31 05:54Z–13:20Z (~7.3 h).
**Denominators:** 25 `Test262 Sharded` `merge_group` runs across **18 distinct PRs**.

> **Caveat, stated deliberately:** this is **one API page, one 7.3 h window** — an observed rate
> for that window, **not a long-run rate**. It is enough to establish the mechanism and an
> order of magnitude; it is not a longitudinal measurement.

- **5 of 18 PRs (28%) needed more than one merge group.**
- **8 rebuilds total. 7 rooted at a `benchmark-refresh` commit; exactly 1 at a genuine PR
  landing ahead** (the only kind a serial queue must pay for).
- **~81 min of `merge_group` validation discarded**, of which **~68 min is
  `benchmark-refresh`-attributable** — roughly **16% of the window**.
- `benchmark-refresh` pushed to `main` **9×** in the window.

The 7:1 ratio is the argument: this is **not** the unavoidable cost of a serial queue.

### Per-PR detail

| PR | groups | discarded | new base was |
| --- | --- | --- | --- |
| #3875 | 2 | 2 m | `67c8c3da` benchmark-refresh 06:21Z |
| #3886 | **4** | 12 m + 36 m + 15 m | `cb86a019` bench-refresh · `0d4900ba` **#3884 merge (legitimate)** · `19ff603f` bench-refresh |
| #3889 | 2 | 14 m | `15a61e41` benchmark-refresh 11:51Z |
| #3887 | 2 | 12 m | `e8b6aec9` benchmark-refresh 12:14Z |
| #3892 | 2 | 13 m | `a19c4abe` benchmark-refresh 12:58Z |
| #3894 | 2 | ~9.5 m | `c1e68eff` benchmark-refresh 13:19Z |

### The incident shape

**#3886 burned 63 minutes across 3 discarded groups before its 4th landed.** That is what a
human reports as *"the queue is stuck"* — and nothing surfaces it. There is **no failure, no
park, no label**. A green run simply vanishes and a new one starts. An earlier diagnosis this
session attributed a ~1 h stall to head-of-line blocking on a workflow-touching PR; that was
**wrong** (the PR had been enqueued and merged normally). This mechanism is the better
explanation. Recording the wrong diagnosis next to the right one so the next person does not
re-derive it.

### Two consecutive fully-green validations discarded

- **#3892** group 1 (base `e0dfd0d2`) went green on all four `merge_group` workflows and was
  superseded **40 seconds before it would have merged**, by a bot push at 12:58:44Z.
- **#3894** group 1 (base `4aa1162c`) `completed success` and was superseded at 13:19:56Z by a
  bot push at 13:19:42Z.

### The timing is near-deterministic

| merge | → bot push | lag |
| --- | --- | --- |
| #3886 11:43:44Z | 11:51:02Z | 7 m 18 s |
| #3889 12:06:41Z | 12:14:44Z | 8 m 03 s |
| #3893 12:46:23Z | 12:58:44Z | 12 m 21 s |
| #3892 13:10:20Z | 13:19:42Z | 9 m 22 s |

Validation takes ~11–13 min and starts within seconds of the preceding merge. A push at +7 to
+12 min lands inside that window **almost every time**. This explains 28% rather than the
occasional collision an unrelated bot would cause.

**Compute cost, not just latency.** Per #3914 the `merge_group` matrix uses **102 of 120
runners**. A discarded validation is not merely ~13 min of wall time — it is ~102 runners'
worth of compute thrown away, on a queue #3914 documents as **runner-saturated**.

## Four traps worth recording independently of the fix

All four mislead triage regardless of how this issue is resolved. They share one shape: **a
signal that looks complete or self-explanatory, and isn't.** Traps 1–2 are this issue's;
traps 3–4 were hit during the #3888 park triage in the same session and each cost real time,
so they are recorded here rather than lost.

1. **`[skip ci]` does not make a push inert to the merge queue.** It suppresses *workflows on
   that commit*. It does **not** stop the queue rebuilding its group. The marker reads as "this
   push is harmless", and that reading is wrong.

2. **The SHA in `gh-readonly-queue/main/pr-N-<sha>` is the BASE commit, not the group head.**
   Two distinct groups for the same PR therefore look like one run set unless you compare the
   embedded SHA. This cost a full sweep during triage and produced an incorrect "all green"
   report on a superseded group.

3. **The regressions artifact names almost no regressed path.** It enumerates the *quarantine*
   list in full, but the only regressed file it names is whichever one the trap gate happens to
   print. On #3888 the 11 non-CT regressions existed **only as a bucket-signature hash**. Anyone
   triaging a park whose failing arm is *not* the trap ratchet gets **a count and no paths** —
   and cannot apply auto-park rule (c) (distinguish real regression from flake/collateral) at
   all. That park was tractable only by luck, because the failing arm happened to be the one
   that prints a filename.

   Related, and independent: the **headline count is dominated by noise**. #3888's "33
   regressions" decomposed to **22 compile_timeout (flake) + 10 `absent` (missing rows) + 1
   substantive**. The first number a human sees overstated the real finding by ~33×.

4. **`Newly trapping: <file>` does NOT mean the file used to pass.** The #3189 ratchet reports
   *trap-category growth*. A file going `fail` → `trap` prints **identically** to one going
   `pass` → `trap`. On #3888 this was misread as a `pass` → trap regression, which led to the
   wrong conclusion that #3596's `fail` → `fail` valve did not apply — when in fact it is the
   matching category. The baseline had the file at `status: fail`; the PR fixed the *first*
   assert, so execution reached a later line and hit a trap **already present on `main`**.

   **Read the prior state from the baseline JSONL, never from the gate's phrasing.**

## Fix options (trade-offs, not a recommendation)

1. **Gate `benchmark-refresh` on an empty merge queue** — simplest; delays artifact freshness
   while the queue is busy, i.e. exactly when refreshes are most frequent.
2. **Batch / debounce its pushes** (e.g. coalesce to a schedule) — fewer rebuilds; same failure
   mode at a lower rate, and still throughput-coupled.
3. **Move the artifacts off `main` entirely** — largest change, **eliminates the class**.
   `loopdive/js2wasm-baselines` is the existing precedent for exactly this: #1528 moved the
   test262 baseline JSONL out of the main repo for unrelated reasons and it is fetched on
   demand.

Option 3 is the only one that removes the coupling rather than reducing its rate. Note also
that #3914's proposed `min_entries_to_merge > 1` would **reduce** exposure (fewer, longer
groups ⇒ fewer collision windows per PR) without removing the mechanism.

## Related

- **#3914** — merge_group critical-path latency and speculative batching. **Adjacent, not
  overlapping**: #3914 makes each validation *faster*; this issue stops validations being
  *thrown away*. #3914's "invalidates all descendant work" concerns speculative batching, and
  its "each re-add rebuilds the group and cancels the in-flight run" concerns re-enqueue loops
  — a **third**, distinct cause. This one is an *external push to `main`*.
- **#2547** `auto-park` — parks PRs failing `merge_group` re-validation. Unrelated failure
  class; a discarded group is not a park and produces no label.
- **#1216** — the `benchmark-refresh` auto-commit-to-main behaviour.

## Acceptance criteria

- [ ] A `benchmark-refresh` push can no longer discard an in-flight `merge_group` validation
      (by any of the three options).
- [ ] Re-measure the rebuild rate over a comparable window; benchmark-refresh-attributable
      rebuilds reach **0**, with legitimate PR-merge rebuilds unaffected.
- [ ] `docs/ci-policy.md` records traps 1–2: `[skip ci]` does not prevent a queue rebuild, and
      the `gh-readonly-queue/main/pr-N-<sha>` SHA is the base, not the head.
- [ ] Traps 3–4 are routed to the regression-gate owner (separate change): the regressions
      report should enumerate every regressed path, not just the trap-gate one, and
      `Newly trapping:` should state the baseline status (`pass → trap` vs `fail → trap`) so the
      applicable valve is unambiguous.

## Reproduction / evidence

```bash
# Group by (PR, base SHA); any PR with >1 distinct base had a validation discarded.
gh api 'repos/loopdive/js2/actions/runs?event=merge_group&per_page=100' \
  --jq '.workflow_runs[] | select(.name=="Test262 Sharded") | "\(.head_branch)\t\(.created_at)\t\(.updated_at)\t\(.conclusion)"'

# Then identify each rebuild's base commit — a benchmark-refresh commit is the signature.
gh api 'repos/loopdive/js2/commits/<base-sha>' --jq '.commit.message'
```
