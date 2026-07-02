---
id: 2962
title: "Native error-object identity + payload stringification: retire `__get_caught_exception` (1,427 opaque standalone fails)"
status: in-progress
assignee: ttraenkler/fable-2
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: codegen, runtime
language_feature: errors
goal: standalone-mode
related: [1473, 2860, 2864, 2958]
origin: "2026-07-02 July Fable audit §3 cluster 2 (direct win + triage force-multiplier; successor to #1473)"
---

# #2962 — natively-thrown errors are opaque, losing tests and masking every other bug

## Problem

**1,427 standalone executed failures** report only "uncaught Wasm-GC
exception (non-stringifiable payload)" (built-ins/Object 400,
language/expressions 234, String 167, …): natively-thrown error objects
(GC structs) have no host-independent stringification or identity, so the
harness cannot render name/message and assertion mismatches all collapse
into one opaque bucket. `__get_caught_exception` is also the **single most
leaked host import (5,810 binaries)** — catch paths still round-trip
through the host to read the payload. This cluster is both a direct test
win and the triage force-multiplier: until it lands, the real root causes
of the largest fail directory are invisible.

## Approach

1. **Canonical native error shape**: ensure every natively-thrown error is
   (or is wrapped into) a `$Object`-backed Error with `name`/`message` own
   properties (the object runtime + boxed-primitive internal slots already
   support this — reuse, don't mint a parallel `$Error` struct unless the
   audit of throw sites shows it's already universal).
2. **Native stringification**: a `__error_to_string` helper (native string
   concat of `name + ": " + message`, with the typeof-classifier fallback
   for non-Error payloads) used by (a) the uncaught-exception path in
   `_start` (print via fd_write + nonzero exit), (b) `String(err)` /
   template interpolation of caught values, (c) #2958's rejection report.
3. **Retire `__get_caught_exception`**: catch-site payload reads resolve
   the payload from the exception's GC value directly (the tag carries the
   ref); route the residual host-mode fast path through the allowlist with
   this issue as the retiring id.
4. Re-run the standalone lane and re-bucket the 1,427 — the follow-up
   issues this exposes are a deliverable of this issue (file per class).

## Acceptance criteria

- A standalone binary throwing `new TypeError("x")` uncaught prints
  `TypeError: x` and exits nonzero — no `env::` imports.
- `__get_caught_exception` leak count drops to ~0 in the per-test imports
  data; allowlist entry annotated or removed.
- The opaque-payload fail bucket shrinks measurably (record before/after);
  newly-visible failure classes filed.
