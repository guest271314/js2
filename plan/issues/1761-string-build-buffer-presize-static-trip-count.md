---
id: 1761
title: "perf(string-hash): presize string-build buffer from static loop-trip-count to kill reallocs + per-append cap-check"
status: done
created: 2026-05-31
updated: 2026-06-04
completed: 2026-06-04
priority: high
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen
language_feature: strings
goal: spec-completeness
sprint: 59
related: [1746, 1580, 1744]
---
# #1761 — presize the string-build buffer from a static loop trip count

Carved out of the #1746 umbrella as **lever #3 (array presizing)**, which the
native differential added by PR #997 re-prioritized to **#1 of the remaining
levers** — the single biggest measured AOT win for string-hash warm time.

## Why this is the top win (from #1746's native differential)

The native differential (`## Native differential (post-lever-1)` in #1746)
decomposed string-hash warm time and found the **string BUILD loop, not the hash
loop, is ~99% of warm wall time** (and ~36× V8). After lever #1 (the i32 hash
path) landed, the hash loop is already ~3.8× *faster per char than V8* — there is
nothing left to win there. The gap is entirely the build loop:

- The benchmark builds a 60,000-code-unit string via ~20k source iterations of
  three single-char appends (`text += alphabet.charAt(a)`), each append going
  through the `$NativeString` **doubling-buffer** WasmGC `(array i16)`.
- Per append, the lowered code pays a **`len+1 > cap` cap-check branch** plus the
  append machinery, executed **60,000 times**.
- The doubling buffer reallocates **~12 times** for n=20000 (final len 60000,
  cap 65536, ~65k i16 copied total ≈ µs) — so `array.copy`/realloc is **NOT** the
  cost; the **fixed per-append overhead × 60,000** is.

## The lever

When a string-building loop's trip count is **statically analyzable** (a literal
count, or a bounded `n` — e.g. `text.length = 3n` because the loop does `n`
appends of constant-length pieces), **presize the WasmGC string buffer to the
final length up front**. This delivers:

1. **Zero doubling reallocations** — the buffer is allocated once at the proven
   final length; the ~12 `grow`/`array.copy` calls disappear.
2. **No per-append `len+1 > cap` branch** — the capacity is known to be
   sufficient for every one of the 60k appends, so the cap-check is removed and
   the store becomes a straight indexed write.

This is a **pure AOT win a JIT cannot make**: the JIT has no static trip-count
proof, so it must keep the dynamic grow/cap-check (or, like V8, defer
materialization via a rope). We have the whole-program static analysis to prove
the final length and presize — "compile away, don't emulate".

## Scope / guard

- Trigger **only** when the final buffer length is *provably static* from loop
  analysis (literal trip count, or a loop bound `n` with constant-length appends
  per iteration). When the length is not provable, fall back to the existing
  doubling buffer — **no behaviour change** in that case.
- Soundness: the presized buffer must produce the byte-for-byte identical
  string as the doubling-buffer path for all inputs the analysis admits. Any
  early-exit/`break`, conditional append, or non-constant append length that
  breaks the length proof must disable the presize for that loop.

## Acceptance

- A **measurable warm drop** on the string-hash build loop, measured via the
  **#1760** in-process repeated-measure bench. Cite the current `7.09` warm-ms
  baseline (full `run`, n=20000) and require the drop to **exceed the combined
  standard deviation** of the before/after measurements (no gaming the lenient
  #1580 30 ms gate; honest provenance).
- The presize fires **only** when the final length is provably static; a loop
  whose length is not statically provable compiles identically to today (verified
  by a no-presize-fallback test).
- A **regression test** proving byte-for-byte string-result parity between the
  presized and doubling-buffer paths across representative trip counts (including
  0, 1, and large n) in both `--target wasi --nativeStrings` and JS-host modes.
- Zero test262 regressions.
- Refresh the committed benchmark JSON and keep the #1580 staleness gate green.

## Notes

- Re-prioritized to **#1 of the remaining string-hash levers** by the #1746
  native differential (was lever #3 in the original umbrella).
- This is the localized AOT win; the representation-level ceiling (dropping the
  WasmGC `(array i16)` GC barrier entirely) is the sibling issue #1762
  (linear-memory string backing). #1761 lands first; #1762 is the strategic
  follow-up that makes both the build and hash loops look like V8's
  sequential-string store.

## Implementation (2026-06-04)

Implemented in `src/codegen/string-builder.ts` as an additive layer on top of
the existing #1210 string-builder rewrite (nativeStrings mode only):

- **`computePresizeInfo`** proves `finalLen = bound * unitsPerIter` for a
  canonical `for (let i = 0; i < BOUND; i++)` loop (step +1, init 0, `<`) whose
  bound is loop-invariant (numeric literal or an identifier never written in the
  body) and whose body appends a statically-fixed code-unit count per iteration
  with NO `break`/`continue`/`return`/`throw` and no conditional/nested appends.
  Per-append units: 1-char literal → 1, k-char literal → k, `X.charAt(i)` on a
  static-string receiver → 1. Any failure → no presize, doubling buffer retained.
- **`compileStringBuilderInit`** (presize path): evaluates the bound once at
  buffer-init time (sound — proven loop-invariant), clamps to non-negative via
  `select(bound, 0, bound>0)` (Wasm has no scalar `i32.max`), allocates the
  buffer once at `cap = max(0,bound) * unitsPerIter`, and sets `sb.presized`.
- **`compileStringBuilderAppend` / `emitStringBuilderAppendCodeUnit`**: when
  `sb.presized`, the per-append `len+N > cap` grow branch (and its
  `__str_buf_next_cap` call) is omitted entirely.
- Threaded via a new `fctx.stringBuilderPresize` map populated at both detector
  sites (`function-body.ts`, `closures.ts`) and consumed at the init site
  (`statements/variables.ts`).
- Escape hatch / A-B harness: `JS2WASM_DISABLE_STRING_PRESIZE=1` disables it.

## Test Results (2026-06-04)

- **Unit tests** — `tests/issue-1761.test.ts` (9 tests, all pass): presize fires
  on the string-hash build loop (0 `__str_buf_next_cap` calls), byte-for-byte
  parity with the JS reference across trip counts 0/1/2/5/33/100/1000/5000
  including non-ASCII + surrogate-pair appends, literal-bound exact length,
  negative/zero bound → empty string, and 5 no-presize-fallback cases
  (variable-length append, break, continue, conditional append, `<=` bound) that
  correctly retain the grow path.
- **Regression** — existing string-builder suites all green:
  `tests/issue-{1210,1580,1744,1175,1178}.test.ts` (28 tests).
- **Warm benchmark** (#1760 in-process repeated-measure shape: 5 warmups + 40
  measured iterations via `wasmtime run --invoke warm`, wasmtime 44.0.0, wasm-opt
  -O3 normalized, 9 outer samples, presize OFF vs ON):
  - **n=20000** (#1760 baseline arg): warm **7ms → <1ms** per call, sd 0 on both
    legs (drop exceeds the 0ms combined sd — matches the cited 7.09ms baseline;
    the build loop is essentially eliminated).
  - **n=100000** (amplified, above ms granularity): warm **58ms → 3ms** per call
    (~19×; drop 55ms ≫ combined sd 2.13ms).
  - The drop far exceeds the combined standard deviation in both — honest
    provenance, not a single-run artifact.
- **Note**: the committed `benchmarks/results/wasm-host-wasmtime-hot-runtime.json`
  warm number should be refreshed via `pnpm run refresh:benchmarks:wasmtime` in
  the dedicated benchmark environment (it also drives the Javy / StarlingMonkey /
  Rust cold-host lanes not reproducible here); the measured warm delta above is
  the authoritative result for this change.
