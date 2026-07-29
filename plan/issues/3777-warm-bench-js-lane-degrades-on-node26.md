---
id: 3777
title: "warm-chart JS lane runs ~15x slower through the benchmark harness than the same source at top level — Node 26 only, and it degrades DURING the measured rounds"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: tooling
goal: performance
depends_on: []
related: [3724, 3726, 3730, 3732, 3759, 3769]
---

# #3777 — warm-chart JS lane degrades ~15x on Node 26, inside the harness only

## Summary

The landing-page "warm speed" chart's **JS baseline is inflated on CI**, which
flatters every wasm:js ratio it publishes. The function is genuinely
TurboFan-optimized (verified — see below), so this is **not** the tiering
problem #3759/#3769 chased. It is specific to the harness path *and* to
Node 26.

Same source, same engine, tier verified in both cases:

| measured via                                   | Node 22 | Node 26      |
| ---------------------------------------------- | ------- | ------------ |
| plain top-level script                          | 310 µs  | 349 µs       |
| **`scripts/no-jit-bench-child.mjs`** (the chart) | 323 µs  | **5107 µs**  |

Node 22 shows no gap. Node 26 shows ~15x. CI runs Node 26, which is why the
published `loop.ts` JS figure has been ~5290 µs while the same source measured
~350 µs anywhere else.

## It is not the tier, and not the factory

- **Not the tier.** `%GetOptimizationStatus` reports the calibrated
  optimized signature both before and after the measured rounds. (The earlier
  "maglev" reading in #3769 was a decoding bug — bit positions shift between
  V8 releases; see that PR's revert note.)
- **Not `new Function`.** Loading through the factory and optimizing *inside*
  it (what the harness does) vs. returning a plain function and optimizing it
  from the caller's scope both measure ~338 µs on Node 26 in isolation.

## The real tell: it degrades mid-measurement

`calibrate(fn)` derives its iteration count by running the function for 100 ms.
On the failing runs it returns `iters = 882`, which back-solves to roughly
**340 µs per call** — i.e. *calibration saw the fast function*. The measured
rounds that follow then report **5107 µs per call** for the same function in
the same process.

So the function starts fast and becomes slow partway through. The harness makes
~10,000 calls in total (80 warm-ups + ~294 during calibrate + 11 rounds × 882),
against ~90 in a direct probe — so the trigger is plausibly call-count or
duration dependent, and a short probe cannot reproduce it.

## Why it matters

The chart's whole purpose is an honest wasm-vs-JS ratio. An inflated JS
baseline biases every row in wasm's favour, and it is invisible without
cross-checking against a second measurement path. It also means any
wasm-vs-JS conclusion drawn from the published chart on Node 26 — including
recent `loop.ts` and `array.ts` comparisons — should be re-derived once this
is fixed.

## Suggested investigation

1. Log `%GetOptimizationStatus` per measured round (not just before/after) to
   find the exact round where it changes, and whether a deopt/re-opt cycle is
   visible.
2. Try `--trace-deopt` / `--trace-opt` on the child under Node 26 to name the
   deopt reason.
3. Bisect the harness protocol: does it reproduce with fewer rounds? With
   `calibrate` skipped and a fixed `iters`? With the warm-up loop removed?
   That isolates whether it is call-count, wall-time, or protocol-shape driven.
4. Check whether the wasm lane has the analogue (its variance is ~0.02%, which
   suggests not, but it should be confirmed rather than assumed).

## Acceptance criteria

- [ ] The harness and a plain top-level script agree within noise on Node 26
      for the same source, as they already do on Node 22.
- [ ] Root cause named (deopt reason, or protocol interaction), not just
      worked around.
- [ ] The published chart's JS column is re-derived and the wasm:js ratios
      restated.

## Provenance

Found while fixing #3769's incorrect maglev diagnosis. A real Node 26 was
downloaded to this sandbox to reproduce CI's engine directly; every number
above is measured on both runtimes side by side rather than inferred.
