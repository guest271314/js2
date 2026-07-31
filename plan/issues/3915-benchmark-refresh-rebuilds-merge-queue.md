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

Because the bot push is _triggered by_ each merge and lands **7–12 min later**, while the next
PR's group is built within seconds of that merge and takes **11–13 min** to validate, **every
merge schedules a bot push timed to land inside the next merge's validation window.**

This is not a bot that occasionally collides with the queue. It is a **feedback loop**, and its
corollary is the alarming part:

> **The tax scales with merge throughput — the busier the queue, the more validation is discarded.**

That is backwards for a pipeline whose job is to land work.

## Measured impact

**Window:** 2026-07-31 09:23:28Z–14:03:44Z = **280 min (4.7 h)**.
**Denominators:** 25 `Test262 Sharded` `merge_group` runs across **17 distinct PRs**.

- **6 of 17 PRs (35%) needed more than one merge group.**
- **8 rebuilds total. 7 rooted at a `benchmark-refresh` commit; exactly 1 at a genuine PR
  landing ahead** (the only kind a serial queue must pay for).
- **129 min of `merge_group` validation discarded**, of which **93 min is
  `benchmark-refresh`-attributable** — **33% of the window**.

> **Two caveats, stated deliberately.**
>
> 1. This is **one API page, one 4.7 h window** — an observed rate for that window, **not a
>    long-run rate**.
> 2. `actions/runs?event=merge_group&per_page=100` is a **sliding page**: older runs fall off as
>    new ones land, so the window bounds and therefore the _absolute_ totals depend on when you
>    sample. An earlier sample of the same day covered 05:54Z–13:11Z and produced different
>    window bounds and different absolute minutes, but the **same 7:1 attribution ratio**.
>    Treat the **ratios** as the finding and the absolute minutes as illustrative of magnitude.

**The 7:1 ratio is the argument**, and it is the part that survives resampling: this is **not**
the unavoidable cost of a serial queue. Only **1 of 8** rebuilds was one the queue had to pay.

### Per-PR detail

Every group except each PR's last is a discarded validation; attribution is by the commit the
_superseding_ group was based on.

| PR    | groups | discarded                | superseded by                                                |
| ----- | ------ | ------------------------ | ------------------------------------------------------------ |
| #3886 | **4**  | 12.0 m + 36.3 m + 15.4 m | bench-refresh · **#3884 merge (legitimate)** · bench-refresh |
| #3887 | 2      | 11.8 m                   | benchmark-refresh                                            |
| #3889 | 2      | 14.4 m                   | benchmark-refresh                                            |
| #3892 | 2      | 13.3 m                   | benchmark-refresh                                            |
| #3894 | 2      | 14.7 m                   | benchmark-refresh                                            |
| #3898 | 2      | 11.1 m                   | benchmark-refresh                                            |

### The incident shape

**#3886 burned 63 minutes across 3 discarded groups before its 4th landed.** That is what a
human reports as _"the queue is stuck"_ — and nothing surfaces it. There is **no failure, no
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

| merge           | → bot push | lag       |
| --------------- | ---------- | --------- |
| #3886 11:43:44Z | 11:51:02Z  | 7 m 18 s  |
| #3889 12:06:41Z | 12:14:44Z  | 8 m 03 s  |
| #3893 12:46:23Z | 12:58:44Z  | 12 m 21 s |
| #3892 13:10:20Z | 13:19:42Z  | 9 m 22 s  |

Validation takes ~11–13 min and starts within seconds of the preceding merge. A push at +7 to
+12 min lands inside that window **almost every time**. This explains a 35% multi-group rate
rather than the occasional collision an unrelated bot would cause.

**Compute cost, not just latency.** Per #3914 the `merge_group` matrix uses **102 of 120
runners**. A discarded validation is not merely ~12 min of wall time — it is ~102 runners'
worth of compute thrown away, on a queue #3914 documents as **runner-saturated**.

## Five traps worth recording independently of the fix

Traps 1-4 mislead triage regardless of how this issue is resolved; the fifth is a documentation failure mode. They share one shape: **a
signal that looks complete or self-explanatory, and isn't.** Traps 1–2 are this issue's;
traps 3–4 were hit during the #3888 park triage in the same session and each cost real time,
so they are recorded here rather than lost.

1. **`[skip ci]` does not make a push inert to the merge queue.** It suppresses _workflows on
   that commit_. It does **not** stop the queue rebuilding its group. The marker reads as "this
   push is harmless", and that reading is wrong.

2. **The SHA in `gh-readonly-queue/main/pr-N-<sha>` is the BASE commit, not the group head.**
   Two distinct groups for the same PR therefore look like one run set unless you compare the
   embedded SHA. This cost a full sweep during triage and produced an incorrect "all green"
   report on a superseded group.

3. **The regressions artifact names almost no regressed path.** It enumerates the _quarantine_
   list in full, but the only regressed file it names is whichever one the trap gate happens to
   print. On #3888 the 11 non-CT regressions existed **only as a bucket-signature hash**. Anyone
   triaging a park whose failing arm is _not_ the trap ratchet gets **a count and no paths** —
   and cannot apply auto-park rule (c) (distinguish real regression from flake/collateral) at
   all. That park was tractable only by luck, because the failing arm happened to be the one
   that prints a filename.

   Related, and independent: the **headline count is dominated by noise**. #3888's "33
   regressions" decomposed to **22 compile_timeout (flake) + 10 `absent` (missing rows) + 1
   substantive**. The first number a human sees overstated the real finding by ~33×.

4. **`Newly trapping: <file>` does NOT mean the file used to pass.** The #3189 ratchet reports
   _trap-category growth_. A file going `fail` → `trap` prints **identically** to one going
   `pass` → `trap`. On #3888 this was misread as a `pass` → trap regression, which led to the
   wrong conclusion that #3596's `fail` → `fail` valve did not apply — when in fact it is the
   matching category. The baseline had the file at `status: fail`; the PR fixed the _first_
   assert, so execution reached a later line and hit a trap **already present on `main`**.

   **Read the prior state from the baseline JSONL, never from the gate's phrasing.**

### A fifth, different in kind: prose written to compensate for broken tooling outlives the breakage

Traps 1–4 are signals that mislead. This one is a **documentation** failure mode, and it is
worth naming separately because the fix is behavioural, not technical:

> **When tooling cannot fix a record, agents write prose explaining that the record is wrong —
> and the prose then outlives the problem.**

Observed the same day on #2916. An agent's claim-release appeared to fail three times, so it
wrote a 24-line warning into the issue file saying the `issue-assignments` record was stuck at
`in-progress` and the issue was effectively blocked. In fact **one of those "failed" attempts
had written the record**: it read `status: released` at 08:55:03Z. The tool reported failure
while having succeeded, the agent trusted its own error output instead of reading the record
back, and the note then explained a problem that no longer existed. Compounding it,
`pre-dispatch-gate.mjs` tested `assignee` alone and ignored `status`, so a **released** record
still printed `CLAIMED by …` (fixed in #3901) — which independently corroborated the wrong
story. **Three separate readers were misled for ~6 h**, and the note was nearly propagated
verbatim into a second PR, which would have preserved the false claim indefinitely.

Mitigations, in order of value:

1. **Read the record back after any write, and cite the record — not the tool's exit output —
   in any prose about its state.** A tool that can report failure after succeeding makes its
   own output inadmissible as evidence.
2. **Date-stamp any prose asserting a mutable external state**, so a reader can tell whether it
   is still current rather than assuming it is.
3. Prefer fixing the record over documenting that it is broken; when that is impossible, say
   explicitly what would make the note obsolete.

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

- **#3914** — merge*group critical-path latency and speculative batching. **Adjacent, not
  overlapping**: #3914 makes each validation \_faster*; this issue stops validations being
  _thrown away_. #3914's "invalidates all descendant work" concerns speculative batching, and
  its "each re-add rebuilds the group and cancels the in-flight run" concerns re-enqueue loops
  — a **third**, distinct cause. This one is an _external push to `main`_.
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
# NB: the SHA embedded in gh-readonly-queue/main/pr-N-<sha> is the BASE, not the group head.
gh api 'repos/loopdive/js2/actions/runs?event=merge_group&per_page=100' \
  --jq '.workflow_runs[] | select(.name=="Test262 Sharded") | "\(.head_branch)\t\(.created_at)\t\(.updated_at)\t\(.conclusion)"'

# Attribute each rebuild by the commit the SUPERSEDING group was based on.
# Look it up — do not hardcode a list of known benchmark-refresh SHAs; doing that
# during this investigation under-counted attribution by one (7 -> 6).
gh api 'repos/loopdive/js2/commits/<base-sha>' --jq '.commit.message'
```

---

# Addendum — two findings from the same session, deliberately NOT the same class

Both were nearly filed as further instances of the rebuild tax above. Neither is. Recording the
mis-classification because "same symptom, unrelated mechanism" is how a wrong fix gets shipped.

## A. A gate whose error message names a cause that does not exist

**The failure that cost ~50 minutes across two agents was not the mechanism — it was the
wording.** `quality` fails with:

```
node scripts/sync-conformance-numbers.mjs --check
[sync-conformance] --check failed: 1 file(s) would change.
[sync-conformance] DRIFT  CLAUDE.md
```

Under a script named \*sync-conformance-**numbers\***, `DRIFT` reads as _"your conformance figure
is stale."_ So triage goes looking for a stale number — and on a fast-moving queue there is
always a plausible story ready to hand ("`promote-baseline` rewrites it on every push to
`main`, main advanced, your copy is old"). That story is coherent, fits the evidence, and is
**wrong**.

**The number never drifted.** Measured on #3901, byte-identical in all three places:

| where                             | conformance line           |
| --------------------------------- | -------------------------- |
| the failing branch                | `29,846 / 43,099 (69.2 %)` |
| `origin/main`                     | `29,846 / 43,099 (69.2 %)` |
| after `pnpm run sync:conformance` | `29,846 / 43,099 (69.2 %)` |

The entire diff is **two blank lines inside the generated block**:

```diff
 <!-- AUTO:conformance-start -->
-
 **test262 conformance**: 29,846 / 43,099 (69.2 %)
-
 <!-- AUTO:conformance-end -->
```

**Mechanism: two gates disagree about one file.** `sync-conformance-numbers.mjs` regenerates the
block _without_ blank lines; **prettier adds them back** (verified in both directions). So
prettier and `sync:conformance` are mutually undoing on `CLAUDE.md`, and `sync:conformance` must
run **last**. Anyone who edits `CLAUDE.md` and then formats it — an entirely reasonable thing to
do — re-breaks the gate.

**It is not a deadlock, and checking that mattered.** `origin/main`'s own `CLAUDE.md` is
prettier-dirty by exactly those two lines **and main is green**, which proves prettier does not
gate that file. So the post-sync form is correct and safe to commit.

**Why this is NOT the rebuild tax.** That one is throughput-driven — it needs a busy queue.
**This one would happen on a completely idle repo.** Filing them together under "merge
throughput creates work for open PRs" would have been a real mis-attribution and would have
pointed the fix at the wrong subsystem.

**Fix at source**, so the gates stop disagreeing: make `sync-conformance-numbers.mjs` emit
prettier-stable output, or have prettier ignore the block. Secondarily, make the message say
_"generated block differs"_ and print the diff, rather than implying the number. Same family as
the `Newly trapping:` fix (#3902/#3915 trap 4): **a message that names a plausible-but-wrong
cause is worse than one that names nothing**, because it manufactures a confident wrong lead.

## B. A detector must be able to say "I don't know"

Trap 5 above says a control that cannot fail is worse than none. This is the same class caught
**inside this session's own watcher**, after the other half of that watcher had already been
positive-controlled — which is why it is worth recording separately.

The watcher polled `gh pr view <N> --json state --jq .state` and treated anything `!= "OPEN"` as
settled. On a transient API blip the call returned **empty**. Empty is not `"OPEN"`, so:

```
16:23:19Z 3900=//[]/red=0 3901=//[]/red=0
ALL SETTLED
```

Both PRs were still open, one of them red. **A network blip read as "everything finished."**

The bug is not the missing retry — it is that the detector had **no representation for "I could
not tell."** Two states (`settled` / `not settled`) forced an unknown into one of them, and the
default fell to the reassuring side. The fix is a third state:

```bash
case "$S" in
  OPEN|MERGED|CLOSED) ;;                      # believed
  *) S="UNKNOWN-API"; BADCNT=$((BADCNT+1)) ;; # NOT settled, and reported
esac
# only conclude when every state was valid AND none was OPEN
if [ "$OPENCNT" -eq 0 ] && [ "$BADCNT" -eq 0 ]; then echo "ALL SETTLED"; fi
```

**Generalises past watchers:** any check that maps a failed observation onto a terminal verdict
will, under intermittent failure, report the reassuring answer. Ask of any gate, detector or
verifier: _what does it do when it cannot see?_ If the answer is "the same thing as when it sees
nothing wrong", it is unsound. This is the shared root of trap 5, `gitTry` returning `{ok:false,
out:""}` so a failed main scan reported every id free (fixed in #3901), and the `contents` API
truncating at 1000 without an error flag.
