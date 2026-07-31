---
id: 3914
title: "CI throughput: why speculative batching failed, and the two levers that actually pay"
status: in-progress
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, merge-queue
goal: dev-velocity
sprint: current
related: [1956, 2519, 2522, 2674, 3431, 3438, 3448, 3456, 3470]
created: 2026-07-31
---

# #3914 — CI throughput: the batching post-mortem, and what to do instead

## TL;DR

Speculative batching (`max_entries_to_build > 1`) did not fail because of a bug.
It failed because **it is arithmetically incapable of helping a runner-saturated
queue**, and every attempt to run it anyway produced oversubscription and
cancellation churn. Three of its four historical failure modes have since been
fixed; the fourth — the runner-capacity one — is _structural_ and has gotten
**worse**, not better, because the shard matrix was deliberately resized upward
(53 → 106 jobs) to exploit a serial queue.

The form of batching that _does_ pay here is the other knob:
**`min_entries_to_merge > 1`** — many PRs in **one** group, validated by **one**
102-job run. That amortises the fixed per-run overhead instead of competing for
runners. It is a repo-ruleset change, not a code change, and it has one real
objection (intra-group masking) which is narrower than the current policy doc
claims.

Independently of any queue-config change, this issue lands two measured wall-clock
wins on the merge_group critical path (≈ **−140 s / −17 %** per src-touching run).

---

## Part 1 — Why batching failed

"Batching" in this repo has meant `max_entries_to_build: 5`: the queue builds up
to five _speculative_ groups concurrently (`main+A`, `main+A+B`, …), each with its
own full CI run. It was enabled by #1956 and turned off during the 2026-06-20
merge-queue wedge (#2519 / #2522). Four distinct things went wrong.

### 1. ALLGREEN masking — the _attribution_ failure (FIXED by #1956)

The regression gate diffed each group against the **main** baseline. In a
multi-entry window the group for B contains A+B, so A's +5 improvement cancels
B's −3 regression and the gate sees net +2. #1956 fixed this: every merge_group
run publishes its merged JSONLs keyed by the group head SHA, and the next group
diffs against its **exact predecessor group** (the group head's first parent).
Per-PR attribution is restored. **This one is genuinely solved.**

### 2. Runner oversubscription — the _structural_ failure (NOT fixed; worse)

This is the real cause of death, and it is pure arithmetic.

- 5 speculative groups × 114 jobs = **570 jobs** against a **~120-runner** pool
  = 4.75× oversubscription.
- Measured consequence (#3431, runs 29631214965 / 29632953272): an _uncontended_
  114-job run finished in 15–19 min; a _contended_ one took **38.5 min**, with
  job starts trickling over ~20 minutes, and 60+ min during queue waves.

The mechanism is worse than "everything is slower". The **head** group is the
only one whose result can actually merge. Its descendants — whose work is
discarded the moment anything upstream changes — compete with it for runners on
equal terms. Speculation therefore **starves the one run that matters** in order
to pre-compute results that are usually thrown away. Throughput went _down_.

**Why this cannot be fixed by tuning:** under a fixed runner pool `R`, if one
group already saturates the fleet (`J = R` shards, wall `W`), then splitting the
fleet `k` ways gives each group `R/k` shards, so each shard does `k×` the work and
each group's wall grows to ≈ `k·W_shard + overhead`. The `k` groups finish
"concurrently" but each took `k×` longer:

```
serial throughput   = 1 / (W_shard + overhead)
k-deep speculation  = k / (k·W_shard + overhead) = 1 / (W_shard + overhead/k)
```

Speculation's **entire** win is amortising the _fixed_ overhead — nothing else.
Here that fixed overhead is ~170 s (41 s pre-shard prefix + 39 s per-job setup +
90 s post-shard tail) out of a 799 s run: a ceiling of **~1.25×** even at
infinite depth, before paying any of the costs below.

And the situation is now _less_ favourable than in 2026-06, not more: #3431/#3470
deliberately grew the merge_group matrix from 53 → 106 jobs _precisely because_
the queue is serial and a lone group should use the whole fleet. Re-enabling
5-deep speculation today would mean 530 jobs on 120 runners.

### 3. Cancellation churn — the _amplifier_ (mitigated, hazard remains)

Any enqueue, dequeue, or ejection invalidates **all descendant** speculative
groups and restarts their full matrices. Three separate high-frequency actors
were poking the queue: the undebounced `auto-enqueue` sweep (#1758, #2560), the
`queue-unstick` cron's dequeue+re-enqueue loop (#3456), and manual re-enqueues.
Each re-add rebuilds the group and **cancels the in-flight `merge_group` run**
(memory `project_merge_queue_requeue_cancels_run`). Churn rate exceeded
completion rate; the queue could not make forward progress.

Mitigations landed: `auto-enqueue` debounced to latest-wins (#2519 part 1),
`queue-unstick.yml` deleted outright (#3456, Option A), agents forbidden from
self-enqueuing (#2548/#2786). But the _structural_ hazard is untouched — with
`k`-deep speculation and a per-PR failure rate `e`, a head ejection discards all
`k−1` descendants' work. Today's observed `e` is ~10 % (3 failing merge_group
runs out of 30 on 2026-07-31), so ~10 % of all speculative work is dead on
arrival.

### 4. Cross-PR interaction false positives — the _diagnostic tax_ (#2674)

A batched speculative tree merged #2075 and #2063 into one SHA (`562d2cde`) and
reported a net −2 regression. Neither PR reproduced it alone — on clean main, on
#2075-on-main, or on the exact merge tree. The real cause was a #2043
late-import-index-shift collision that only appears when two import-adding PRs
combine.

Honest reading: this is batching **working** — it found a genuine latent bug that
serial validation would have missed. But the cost was hours of triage on a PR
that was individually correct, and the failure surfaces on a synthetic tree that
no developer can check out and reproduce against. Any batching scheme must budget
for this class, and must make the batch trivially splittable when it hits.

### Summary table

| #   | failure mode                                 | status today                                        | blocks re-enabling? |
| --- | -------------------------------------------- | --------------------------------------------------- | ------------------- |
| 1   | ALLGREEN masking (attribution)               | **fixed** (#1956 predecessor-group diff)            | no                  |
| 2   | runner oversubscription                      | **worse** (matrix grew 53 → 106 for a serial queue) | **yes — fatal**     |
| 3   | cancellation churn                           | mitigated (#2519, #3456, #2786); hazard structural  | yes, at depth       |
| 4   | cross-PR interaction false positives (#2674) | unchanged                                           | tax, not a blocker  |

**Verdict: do not re-enable `max_entries_to_build > 1`.** It was not a
mis-configuration and it does not deserve another attempt at these fleet sizes.

---

## Part 2 — The batching that would actually pay

The queue exposes a second knob that is not speculation:
**`min_entries_to_merge`** — how many PRs go into **one** group. One group means
**one** 102-job run for N PRs. Runner pressure is unchanged; the fixed overhead
is divided by N. That is the amortisation speculation was reaching for, without
the contention that killed it.

Expected value at today's numbers (13.3 min per src merge_group run, per-PR
failure rate e ≈ 0.10, batch fails → one wasted run then serial re-validation):

| model          | min/PR | vs serial               |
| -------------- | ------ | ----------------------- |
| serial (today) | 13.3   | 1.00×                   |
| batch N=2      | ~9.2   | **1.45×**               |
| batch N=3      | ~8.0   | **1.65×**               |
| batch N=4      | ~7.6   | 1.75× (tail risk grows) |

Batching also helps _disproportionately_ here because doc-only groups cost 2 min,
not 13 — and roughly half of 2026-07-31's 28 merges were doc-only. A doc PR
batched with a src PR is free.

### The one real objection, and why it is narrower than the policy doc says

`docs/ci-policy.md:113` states: _"`min_entries_to_merge` stays 1 — single
multi-PR groups would collapse per-PR runs and reintroduce intra-group masking."_

That is correct but over-broad. Intra-group masking applies **only** to the
test262 _delta_ gate. It does not apply to:

- `quality`, `cheap gate`, `linear-tests`, `equivalence-*` — pass/fail, not
  deltas; a batch that breaks any of them fails, period;
- the catastrophic guard (#1668) and the standalone floor (#1897/#2097) —
  **absolute** thresholds, immune to intra-group cancellation.

And for the delta gate itself, masking is an artefact of comparing **aggregate
counts**. The merged JSONL is per-test: a group of A+B that regresses 3 tests
still names those 3 test ids in the predecessor diff. What batching costs is
**attribution** (which of A or B did it), not **detection**.

So the design is _optimistic batching with split-on-failure_: batch merges when
green; on a red group, fall back to serial re-validation to attribute. Cost of a
red batch = one wasted 13-min run, which is exactly the `e`-weighted term already
priced into the table above.

### Recommended configuration (repo ruleset — requires admin; NOT changed by this issue)

```
max_entries_to_build: 1          # unchanged — see Part 1
min_entries_to_merge: 3
min_entries_to_merge_wait_minutes: 5     # so a quiet queue never stalls
max_entries_to_merge: 5          # unchanged
```

Pre-conditions before flipping it:

1. Confirm the delta gate reports **per-test** regressions (it does — #1956
   predecessor diff + bucket-by-path), so a red batch is diagnosable.
2. Confirm the absolute guards (#1668, #1897, #2097) are wired on the merge_group
   path (they are — `merge shard reports` runs them).
3. Roll out at `min_entries_to_merge: 2` first and watch the red-batch rate for a
   day before going to 3.
4. `docs/ci-policy.md` §3 must be updated — its current text both forbids this
   _and_ states `max_entries_to_build: 5`, which contradicts the live ruleset
   (`scripts/gen-test262-mg-matrix.mjs` and `test262-sharded.yml` both document
   the ruleset as serial). One of the two is stale; the doc is.

---

## Part 3 — Measured critical path, and the two wins landed here

Ground truth: merge_group run **30631849709** (PR #3892, 2026-07-31, 799 s /
13.3 min, 114 jobs). Per-job and per-step timings pulled from the Actions API.

| phase                                                   | t (s)        | cost                      | note                                                     |
| ------------------------------------------------------- | ------------ | ------------------------- | -------------------------------------------------------- |
| `detect test262-relevant changes`                       | 0 → 41       | **41 s**                  | 33 s of it is a `fetch-depth: 0` checkout                |
| shard jobs start                                        | 44 → 52      | —                         | …for 101 of 106                                          |
| **starved shard starts**                                | 90 → **184** | **~89 s**                 | 5 jobs; the last-finishing job of the run is one of them |
| per-shard fixed overhead                                | —            | 39 s                      | setup + checkout + install + bundle + upload (median)    |
| `Run shard`, js-host (72)                               | —            | mean 408 s, max 468 s     | 29,353 runner-s total                                    |
| `Run shard`, standalone (34)                            | —            | mean 471 s, max **542 s** | 16,000 runner-s total — **long pole**                    |
| last shard ends                                         | → 709        |                           | standalone 2/34: started t+134, ran 575 s                |
| `merge shard reports` ∥ `check for test262 regressions` | 712 → 798    | **90 s**                  | tail                                                     |

Two defects fall straight out:

### Win A — the lane split is stale (again)

The 72/34 matrix was scaled from a **2.13:1** host:standalone work ratio measured
at run 29807524490. The measured ratio is now **1.835:1**. At 72/34 the lanes are
inverted and standalone is the long pole by ~74 s.

Fixed: **66 / 36** (= 1.833). Both lanes land on ~444 s mean shard work, ~510 s at
the observed per-lane max/mean skew — within ~2 s of each other.

> This constant has now drifted **twice**. `gen-test262-mg-matrix.mjs` gains a
> "re-deriving this" note making it a recurring check rather than a constant.

### Win B — the matrix is 4 jobs over the ceiling, and pays ~89 s for them

Concurrent demand at t+45 s is 106 shards + 13 `ci.yml` merge_group jobs
(`changes`, `quality`, `cancel-test262-on-quality-failure`, `linear-tests`,
`equivalence-shard` ×8, `equivalence-gate`) + this workflow's `cheap gate` and
`changes` ≈ **121** — just over 120. The 14-runner reserve bought 4 extra shards
and paid ~89 s of start skew on the critical path for them.

Fixed: reserve **18** → **102** shards.

### Win C — 33 s of full-history checkout as a serial prefix

Every shard `needs:` the `changes` job, so nothing starts until it finishes. It
spent 33 s of its 38 s on `fetch-depth: 0` — solely to run one
`git diff base head`. That is a two-dot **tree** comparison and needs no merge
base, so depth-1 objects for the two SHAs suffice (a shard's own default-depth
checkout is 9–10 s).

Fixed: `fetch-depth: 1` + explicit `--depth=1` fetch of both SHAs, with an
`--unshallow` retry **before** the fail-safe — so the answer is identical to the
old behaviour and full history is only paid for when the cheap path fails.

### Combined expected effect

```
critical path  = 41 (prefix) + 4 + 134 (starved start) + 575 (longest shard) + 90 (tail)  = 799 s
               →  17 (prefix) + 4 +  45 (no starvation) + ~511 (rebalanced)  + 90 (tail)  ≈ 667 s
```

≈ **−132 s / −17 %** on every src-touching merge_group run. Under a serial queue
that converts directly into queue throughput.

---

## Acceptance criteria

- [x] `JS_HOST_CHUNKS` / `STANDALONE_CHUNKS` re-derived from a completed
      merge_group run; both lanes' projected max within ~1 min of each other.
- [x] `MERGE_GROUP_RESERVED_RUNNERS` raised to cover measured concurrent demand;
      no shard job should start >60 s after the first.
- [x] `changes` job no longer does a full-history checkout on the critical path,
      with a deepen-and-retry fallback so the emitted `run_shards` answer is
      unchanged in every case.
- [x] `tests/issue-3431-mg-matrix.test.ts` updated to the new constants and
      asserting lane-ratio consistency rather than a frozen number.
- [x] Batching post-mortem written down with the arithmetic, so
      `max_entries_to_build > 1` is not attempted a third time without new
      runner capacity.
- [ ] **Follow-up (needs repo admin):** reconcile `docs/ci-policy.md` §3 with the
      live ruleset, and evaluate `min_entries_to_merge: 2` → `3`.
- [ ] **Verify after merge:** on the first post-merge `merge_group` run, confirm
      (a) max shard start < 60 s, (b) both lanes' max job within ~1 min,
      (c) `changes` job < 20 s, (d) total run wall ≈ 11 min.

## Notes / non-goals

- The 4 % of the run spent in the post-shard tail is dominated by the regression
  gate's own `fetch-depth: 0` checkout (34 s), which **does** need full history
  for #1081 merge-base resolution. Left alone deliberately.
- The structural ~146k redundant harness compiles per run (L3/L4 in
  `plan/ci-acceleration-review.md`) remain the largest theoretical win and remain
  out of scope: L3 is an oracle-policy change (v9 + rebase), L4 needs the
  #1046/#33/#34 linker.
