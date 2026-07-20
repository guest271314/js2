---
id: 3498
title: "Landing benchmark: four honest backend/runtime lanes"
status: in-progress
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: xl
complexity: L
feasibility: hard
reasoning_effort: max
task_type: performance
area: benchmarking, ir, codegen-linear, website, ci
goal: backend-agnostic-ir
depends_on: [3482]
related: [1760, 1764, 3288, 3336, 3482]
assignee: ttraenkler/sendev-3498
origin: "2026-07-20 user request to implement the landing-page four-lane backend benchmark"
---

# #3498 — Landing four-lane backend benchmark

## Objective

Benchmark the exact checked-in `fib.js`, `fib-recursive.js`, `array-sum.js`,
and `string-hash.js` sources through Node/V8, JS2 WasmGC under the existing
Wasmtime/Cranelift host, JS2 typed SSA/shared `LinearMemoryPlan` through Porffor
IR to Clang/native, and pinned plain Porffor to Clang/native. `object-ops.js` is
out of scope. The output must distinguish valid measurements from unsupported
or sanitizer-contaminated cells without ranking silently different semantics.

## Methodology

- Reuse the current landing corpus and Wasmtime generator plus #3482's generic
  exact-source, direct-native, sanitizer, and reporting helpers; do not copy or
  rewrite sources and do not narrow shared linear-memory IR.
- Hash and oracle every source. Validate each executable at `coldArg`,
  `runtimeArg`, and deterministic fixed inputs before accepting samples.
- Keep build, startup, cold-first-call, and warm steady-state evidence separate.
  Retain commands, versions, source SHA/bytes, phase timings, CPU/wall/RSS,
  artifact sizes, and raw interleaved samples (5 warmup + 21 measured where
  practical). Disclose any retained compatibility methodology.
- Keep Porffor optional. Preserve pinned plain-Porffor accesses except the
  existing LP64 printf normalization and run ASan/UBSan separately. Plain-lane
  UBSan makes optimized timing non-authoritative; JS2-native supported rows
  must be sanitizer-clean.

## Support-matrix semantics

The machine-readable result contains exactly one cell for each of four kernels
and four lanes. A cell is `supported`, `unsupported`, or
`unsafe-non-authoritative`. Unsupported cells have no timing value and include
a stable phase, diagnostic code, evidence, and follow-up when needed. Missing,
skipped-success, empty-success, and numeric-zero sentinel cells are invalid.

## Slices

1. Generalize the #3482 adapter through an additive API, publish the canonical
   corpus descriptor, and land a schema/oracle/support probe while preserving
   all #3482 hashes and behavior.
2. Execute and sanitize all four lanes for `fib` and `fib-recursive`, fixing
   only narrow backend-neutral defects that are safe in this PR.
3. Probe both native routes for arrays and strings; measure correct support or
   retain evidence-backed blocked cells and allocate focused follow-up plans.
4. Add the artifact-only/manual Ubuntu capture, documentation, package commands,
   and landing integration supported by the honest matrix. PR CI runs focused
   correctness/support/sanitizer probes; no performance thresholds are added.

## Acceptance criteria

- [ ] The four canonical source files are the sole corpus, with asserted bytes,
      hashes, Node oracles, and no source substitution or silent omission.
- [ ] Node/V8 and JS2 WasmGC/Wasmtime execute all four kernels correctly.
- [ ] Both Porffor routes execute `fib` and `fib-recursive`, or a concrete
      compiler defect is represented by an explicit blocked cell and planned
      follow-up after any safe minimal fix is considered.
- [ ] Arrays and strings are probed through both Porffor routes and are either
      correct measurements or explicit evidence-backed blocked cells with
      follow-up issues.
- [ ] Focused `tests/issue-3498*.test.ts` cover schema completeness, exact-source
      identity, output equality, unsupported semantics, and sanitizer authority.
- [ ] Documentation discloses frontend, ABI, runtime, optimizer, allocator, and
      measurement confounders; the manual workflow retains full artifacts and
      applies no speed threshold.

## User origin

Requested directly by the project owner on 2026-07-20, including the canonical
four-file corpus, exact four lanes, methodology constraints, minimum landing
slice, branch/claim workflow, and non-draft upstream PR handoff.

## Implementation notes

Pending current-main probes. Record root causes, safe generalizations, support
evidence, tests, and follow-up issue IDs here before handoff.
