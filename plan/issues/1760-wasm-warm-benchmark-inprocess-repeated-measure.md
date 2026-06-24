---
id: 1760
title: "wasm warm-runtime benchmark lane: in-process repeated-measure (current cold−baseline subtraction is noise-dominated)"
status: done
created: 2026-05-31
updated: 2026-06-24
completed: 2026-06-24
sprint: 65
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: benchmarks
goal: platform
related: [1580, 1746]
origin: surfaced while refreshing the #1746 i32-hashpath warm benchmark on #990 — the published warm number could not move because the metric's run-to-run noise exceeded the effect size
---
# #1760 — wasm warm-runtime benchmark lane: in-process repeated-measure

## Problem

`scripts/generate-wasmtime-hot-runtime.mjs` (the landing-page
Wasmtime-vs-V8 per-request chart generator) derived the **wasm warm**
number as:

```
warm = (full-process cold wall-time, runtimeArg)
      − (full-process baseline wall-time, arg=0)
```

i.e. it subtracted two `wasmtime run` **process** wall-times (each ~30 ms,
dominated by process spawn + wasmtime boot + cwasm mmap) to recover a
**few-ms per-call** signal. Process-startup jitter is itself ms-scale, so
the subtraction's noise floor exceeded the signal it was trying to measure.

### Evidence — 6 back-to-back runs of `string-hash` warm on an IDENTICAL binary

```
12.31, 5.43, 9.36, 5.65, 11.43, 6.21  ms     (≈ 2.3× spread)
```

The previously-published committed value (9.0 ms) sat squarely inside that
band, and so did every fresh sample — there was no reproducible warm delta
in either direction. This blocked landing the #1746 lever-#1 i32 hash-path
win (PR #990): the compiler fix is real at the instruction level (the hash
loop lowers to pure `i32.mul`/`i32.add`), but the published benchmark could
not demonstrate it because the metric's variance was larger than the
effect size. Committing any single run would have been publishing noise.

By contrast the **V8 warm lane** (`timeNodeWarmIter`) was already stable
(~0.58 ms for string-hash) because it spawns node once, warms TurboFan,
then measures many **in-process** iterations and reports the median —
startup amortized away.

## Fix

Give the wasm lane the same in-process repeated-measure shape as the V8
lane. Append a self-timing `warm` export to each benchmark program:

```js
/** @param {number} __n @returns {number} */
export function warm(__n) {
  for (let __w = 0; __w < WARMUP; __w++) { run(__n); }       // settle caches / branch predictors
  let __best = 1e18, __sink = 0;
  for (let __m = 0; __m < MEASURED; __m++) {
    const __t0 = performance.now();                          // CLOCK_MONOTONIC in wasmtime, sub-ms
    const __r = run(__n);
    const __dt = performance.now() - __t0;
    __sink = (__sink + __r) | 0;                             // keep run() observable (no DCE)
    if (__dt < __best) __best = __dt;
  }
  return __best;                                             // steady-state MIN per-call ms
}
```

One `wasmtime run --invoke warm` process → wasmtime/Cranelift startup is
amortized across all `MEASURED` iterations. Cranelift AOT code does not
tier up, so a short warmup suffices. We return the **minimum** per-call ms
(the steady-state floor — least scheduler-noise-contaminated), and spawn
that process `MEASURED_RUNS` times to build a sample array for the
std-dev/median the chart consumes, exactly parallel to `timeNodeWarmIter`.

Mechanism notes:
- The driver is plain JS with a JSDoc `@param {number}` so the export takes
  a numeric (not boxed `externref`) argument — matching how the program
  files already type `run` — and so wasmtime `--invoke` can pass the
  runtimeArg. (A `.ts` strict variant breaks `array-sum`'s `const values =
  []` → `never[]`; the loose-JS + JSDoc path matches the existing program
  files and compiles all four cleanly.)
- `performance.now()` compiles (under `--target wasi`) to a
  `clock_time_get(CLOCK_MONOTONIC)` helper returning f64 ms with sub-ms
  resolution — self-contained in the module, no extra host imports beyond
  WASI (which wasmtime always provides). The standalone-import check still
  passes (`imports: []`).
- The cold lane is unchanged — cold startup is a legitimately separate
  per-request metric.

## Result — stability proof (`string-hash` warm, identical binary, new methodology)

```
6.95, 7.14, 7.14, 7.22, 7.07, 7.09  ms      (spread 0.27 ms, ≈ 3.8%)
```

Down from a 2.3× spread to ~4%, comparable to the V8 lane. The warm
`wasmStdUs` in the re-baselined JSON is now tiny (string-hash 0.067 ms,
array-sum 0.0045 ms, fib-recursive 0.011 ms; fib 0.90 ms — its 20 M-iter
loop is longer and more scheduler-exposed but min-per-call keeps it
stable). A few-ms per-call codegen delta is now resolvable, so #990 can
merge this and re-refresh to show the i32 win as a real, reproducible
drop.

## Deliverables

- [x] `scripts/generate-wasmtime-hot-runtime.mjs` — in-process warm lane
      (`WARM_DRIVER_SOURCE`, `timeWasmtimeWarmIter`, warm-variant compile +
      precompile), cold lane untouched.
- [x] Re-baselined `benchmarks/results/wasm-host-wasmtime-hot-runtime.json`
      (+ `website/public/...` copy) on **current main's** compiler with the
      new methodology.
- [x] Stability proof recorded above (6 identical-binary samples).

## Resolution (2026-06-24)

Status-only correction. The implementation already landed on `main` in commit
`7a9ba70e6` ("fix(#1760): in-process warm lane for wasm-host benchmark") — the
warm lane (`WARM_DRIVER_SOURCE`, `timeWasmtimeWarmIter`, `--invoke warm`,
warm-variant compile + precompile) is present in
`scripts/generate-wasmtime-hot-runtime.mjs`, and
`benchmarks/results/wasm-host-wasmtime-hot-runtime.json` carries the
re-baselined `warm` scenario with `wasmStdUs` provenance. Subsequent commits
(`e92460a68`, `e2c0aff99`) built further on it (rust host for the cold lanes).
All three Deliverables are satisfied on `main`; only the frontmatter `status`
was stale (`ready` → `done`). This warm in-process repeated-measure lane is the
measurement gate that unblocks the string-hash perf work (#1762 / #2621): warm
per-call deltas are now resolvable (string-hash spread down from ~2.3× to ~4%).
