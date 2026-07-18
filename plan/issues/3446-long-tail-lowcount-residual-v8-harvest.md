---
id: 3446
title: "long-tail low-count residual (v8 harvest): array-too-large, float-unrepresentable, runtime max-call-stack, timeouts"
status: ready
created: 2026-07-19
priority: low
task_type: bug
area: test262-conformance
goal: standalone-mode
model: fable
sprint: current
related: [1781, 3417, 1171, 301, 2669]
---

# #3446 — long-tail low-count residual (v8 harvest, 2026-07-19)

## Summary

Catch-all for the remaining distinct sub-50 signatures from the 2026-07-19
both-lane harvest that don't warrant a dedicated issue (each tiny, several
one-off), so nothing is left uncaptured. Prior specific trackers (#301
float-unrepresentable, #1171 timeout-non-determinism) are `status: done`.

## Signatures captured

| signature | default | standalone | prior tracker |
| --- | ---: | ---: | --- |
| `requested new array is too large` (Array length edge, e.g. S15.4.2.2) | 4 | 4 | #2669 (destructuring-adjacent, ready) |
| `float unrepresentable in integer range` (numeric coercion / obj-rest setter) | — | 5 | #301 (done) |
| `Maximum call stack size exceeded` (runtime, tagged-template / generator TCO) | 3 | 2 | #1607 (done, compiler-side) |
| `timeout (Ns)` incl. strict-rerun | ~141 | ~12 | #1171 (done) — largely infra/load flake, not codegen |

## Notes / sample paths

- **array-too-large**: `built-ins/Array/length/S15.4.2.2_A2.1_T1.js` — huge
  requested array length should throw `RangeError`, not trap; a length-bounds
  guard gap.
- **float-unrepresentable**: `language/statements/for-await-of/async-gen-decl-dstr-obj-rest-to-property-with-setter.js`
  — an `f64→i32` truncation on an out-of-range value; add the range check.
- **runtime max-call-stack**: `language/expressions/tagged-template/tco-call.js`
  — proper-tail-call not applied at runtime for tagged-template calls.
- **timeout**: dominated by destructuring iterator-error tests
  (`ary-init-iter-get-err-*`). Per project memory (`pass→compile_timeout = load
  flake`), most default-lane timeouts are contended-pool nondeterminism (#1171),
  not genuine infinite loops — but the recurring `ary-init-iter-get-err` cluster
  is worth a spot-check for a real non-terminating iterator drain.

## Priority

Low — small counts, several are flake or spec-edge. Filed for completeness so the
harvest coverage audit shows zero uncaptured signatures.
