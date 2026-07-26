---
id: 3670
title: Baseline-`pass` tests failing on the local harness lane — local/CI divergence sighting
status: ready
sprint: current
priority: medium
horizon: s
area: testing
related: [3668, 3669]
created: 2026-07-26
---

# #3670 — baseline-`pass` tests fail on the local harness lane

## Observation

Running the honest harness lane locally (`runTest262File` →
`assembleOriginalHarness`) on current `upstream/main`, several tests recorded as
`pass` in the committed CI baseline jsonl fail:

| test                                                | baseline | local                                                       |
| --------------------------------------------------- | -------- | ----------------------------------------------------------- |
| `built-ins/Object/defineProperty/15.2.3.6-4-202.js` | pass     | fail — `obj['0'] descriptor should not be enumerable`       |
| `language/expressions/function/name.js`             | pass     | fail — `obj['name'] descriptor value should be ; …`         |
| `built-ins/GeneratorPrototype/return/name.js`       | pass     | fail — `strict rerun: obj should have an own property name` |

All three failures are `propertyHelper`-mediated, which is suggestive given
#3669, but the divergence itself is the thing to explain: these are recorded as
passing in the baseline that CI gates on.

Not investigated further — filed so it isn't lost. Sample was small and
opportunistic, so the true count is unknown.

## Ruled out

**Not PR #3653.** That PR is docs-only (adds three issue files, no `src/`, no
`scripts/`, no tests), confirmed by its author. The initial suspicion was wrong.

Remaining candidates: drift from another commit landed after the baseline was
promoted (baseline promoted 2026-07-26 00:48; these were observed against a
09:35 tip), or a genuine behavioural difference between the local in-process
lane and the sharded CI worker lane.

## Why it matters, and why it is not urgent

It does **not** invalidate `scripts/harness-flip-probe.ts` (#3668). That tool is
local-vs-local A/B by construction and refuses the committed baseline as an arm,
so a stable local-only failure costs **sensitivity** (a test stuck at fail on
both arms cannot show a flip) but can never manufacture a **false** flip.

It matters because it is the second independent sighting of local/CI lane
divergence in one session, and because the baseline is what the PR regression
gate compares against. If the local lane is right and the baseline is stale, the
gate is scoring against a stale reference; if the baseline is right, the local
lane misreports — and the local lane is what agents use to triage.

## Suggested next step

1. Re-run the three tests against the exact SHA the baseline was promoted from,
   to separate "drift since promotion" from "lane difference".
2. If it is a lane difference, compare the in-process runner's sandbox/harness
   assembly against `scripts/test262-worker.mjs` for the `propertyHelper` path.
3. Widen the sample before quoting any count — three tests found opportunistically
   is not a measurement of the population.
