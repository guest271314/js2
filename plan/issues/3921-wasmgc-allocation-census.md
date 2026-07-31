---
id: 3921
title: "tooling: per-type WasmGC allocation census — attribute struct.new/array.new volume by type"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: tooling
area: codegen, tooling
language_feature: compiler-internals
goal: performance
related: [3780, 3756, 3684, 3686]
origin: "#3780 round 4 — allocation volume turned out to be the dominant standalone cost, and 34 MB of the 43.6 MB per acorn parse cannot be attributed with any existing tool"
---

# #3921 — per-type WasmGC allocation census

## Problem

#3780 round 4 established that **allocation volume is a first-class cost** in
the standalone lane and that nothing had been measuring it. Summing inter-GC
heap growth from `--trace-gc`, the standalone acorn module allocated **58.0 MB
per 226 KB parse** — ~257 bytes per source byte — against a GC share of 24-37%
of parse time on that box.

Two lowerings took it to 43.6 MB. The problem is what is left:

| | count / parse | our size | total |
| --- | ---: | ---: | ---: |
| AST `Node` structs | 32,487 | 292 B | 9.5 MB |
| AST arrays | 4,275 | ~56 B empty | ~0.2 MB |
| token string values | 41,889 tokens / 126 KB chars | 2 B/char + header | <1 MB |
| **accounted** | | | **~10 MB** |
| **measured** | | | **43.6 MB** |

**~34 MB per parse — roughly 810 bytes per token — is transient garbage that
the returned AST does not account for, and there is currently no way to say
what it is.**

## Why the existing tools do not answer it

Both measured, both negative — recorded so the next attempt does not repeat
them:

- **V8's sampling heap profiler does not observe WasmGC `struct.new`.**
  `HeapProfiler.startSampling` (2 KB interval) across a 58 MB parse sampled
  **0.2 MB total**, all of it attributed to a single `js-to-wasm` frame.
- **`--trace-gc-object-stats` is unavailable** on the Node build in use
  (accepted silently, prints nothing).
- A **V8 heap snapshot** cannot be taken mid-parse: the benchmark export is one
  synchronous call, and the AST is unreachable by the time it returns.
- **Static `struct.new` site counts are not volume.** The module has 1,137 vec
  sites and 1,926 string-carrier sites; that says where allocation *can*
  happen, not how often. Reading them as volume is the same
  axis-to-end-to-end extrapolation trap `#3684`'s whole-parse decomposition
  caught (an axis can be 4.5x off V8 and still be 2% of the mix).

So the census has to come from the emitter.

## Direction

Env-gated (`JS2WASM_ALLOC_CENSUS=1`), instrumentation-only, off by default:

1. At finalize, walk every function body and insert a **stack-neutral**
   `global.get $c_T / i32.const 1 / i32.add / global.set $c_T` immediately after
   each `struct.new` / `struct.new_default` / `array.new*`. The counter sequence
   leaves the freshly-allocated reference in place, so no body needs
   restructuring and no type changes.
2. One **exported** mutable `i32` global per allocated type. Export them by
   name — `wasm-opt` renumbers types, so a `typeIdx`-keyed reader would go
   stale, while export names survive.
3. A reader script that pairs each count with the type's computed instance size
   (fields × width + header) to produce bytes-per-type, which is the number the
   optimisation decisions actually need.

Notes for whoever builds it:

- Counts are only meaningful against a **known operation count** — report
  per-parse, not per-run.
- The instrumented binary is slower and larger; it is a measurement build, not
  something to benchmark against. Volume is what it is for, and volume is
  deterministic, so contention does not matter.
- `optimize: 4` still runs. Verify `wasm-opt` does not sink the increments past
  the allocation or merge counters for two types that got merged — comparing
  the census total against the independent `--trace-gc` sum (which needs no
  instrumentation) is the cross-check.

## Scope

- [ ] Emitter-side census pass, env-gated and off by default.
- [ ] Reader that reports count and **bytes** per type, per operation.
- [ ] Cross-check the census total against the `--trace-gc` inter-GC sum on the
      standalone acorn parse; they should agree to within a few percent.
- [ ] Publish the acorn breakdown — that is the artifact #3780's next round
      needs, and the reason this issue exists.

## Acceptance criteria

- [ ] With the flag off, the emitted binary is byte-identical to today's.
- [ ] With the flag on, the standalone acorn parse yields a per-type allocation
      table whose total agrees with the independent `--trace-gc` measurement.
- [ ] The ~34 MB currently unattributed in #3780 is attributed to named types,
      or the discrepancy between census total and `--trace-gc` total is itself
      explained rather than left as a rounding remark.
