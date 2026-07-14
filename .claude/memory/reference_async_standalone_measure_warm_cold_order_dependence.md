---
name: reference_async_standalone_measure_warm_cold_order_dependence
description: "Async-generator/Promise standalone test262 results are ORDER-DEPENDENT in the in-process (warm) runner: the SAME file passes when run after other async files but FAILS when run cold (fresh process, isolated). Warm-up spuriously flips genuinely-failing files to pass, so BATCH scans UNDER-COUNT async host-free-fails; COLD isolated runs are authoritative. Also: the runner's per-assert LINE labels are unreliable for async tests (microtask reorder shifts the assert-count→source-line mapping) — instrument the wrapped source, never trust the label. When measuring async standalone floor / bucketing async fails, run cold-isolated and instrument source."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Surfaced 2026-07-13 (opus-asyncthen, scoping async-gen dstr host-free-fails).**
Two measurement artifacts that corrupt async standalone bucketing if you trust
the batch runner:

**Artifact A — unreliable per-assert line labels.** For async tests, microtask
reordering shifts the assert-count→source-line mapping, so a scan label like
"assert #6 notSameValue" frequently mislabels the TRUE failing assert. Verify
every root by instrumenting the actual wrapped source + isolated repros, not the
scan's line label.

**Artifact B — in-process warm/cold order-dependence (the dangerous one).** The
SAME async file **passes when run after other async files (warm) but FAILS run
cold** (fresh process, isolated) — deterministically. Warm-up spuriously flips
genuinely-failing files to *pass*, so a batch scan **UNDER-COUNTS** async
host-free-fails; the true failing set is larger. **Cold isolated runs are
authoritative** for async floor measurement. Suspected root (TBD): compiler
program/checker cache affecting later-file codegen, or shared host scheduler
state leaking across in-process compiles. Worth a runner-hygiene fix (filed under
#3245) — until then, measure async standalone fails cold-isolated.

**Breadth CONFIRMED far beyond async (lead, 2026-07-13, diffing two consecutive
promoted standalone baselines 34 min apart):** the order-dependence churns
**~277 tests per run** — and they're DETERMINISTIC pure functions (Math.cos/sin/
tan/log/pow, parseInt, parseFloat, Date setters, Number numeric-separator
literals, DataView.getFloat), which cannot really regress. Between two baselines:
277 flipped host-free-pass→fail AND 269 flipped fail→host-free-pass (near-
symmetric = flake, not code). Net host_free_pass moved only −8 (22,973→22,965,
53.29→53.28%) while total pass rose +209. **⇒ single-run standalone host_free_pass
has a ~±0.6% (~277-test) noise band; a 0.1% single-run move is UNINTERPRETABLE.**
Judge standalone by the #2097 HIGH-WATER FLOOR (ignores churn) or a multi-run
median, never a single-run %. Real gains only show once they exceed the ~277
band. Fix: runner-hygiene (#3245).

**Consequence for dispatch:** don't size an async-gen host-free-fail lever from a
warm batch scan — it will read too small. And a "cluster of N error-path fails"
may be a MIRAGE: opus-asyncthen found the 29 "error-machinery" async-gen dstr
fails actually pass their error probe and fail on a *preceding* binding assert
rooted in the any-container element-rep substrate [[reference_postflip_standalone_hostfreefail_is_the_frontier]]
(#3244) — the whole async-gen dstr host-free-fail cluster collapses into #3244 +
the object-`===` eq fix, not independent error-machinery work.
