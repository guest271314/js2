---
id: 1761
title: "perf(string-hash): presize string-build buffer from static loop-trip-count to kill reallocs + per-append cap-check"
status: ready
created: 2026-05-31
updated: 2026-06-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen
language_feature: strings
goal: spec-completeness
related: [1746, 1580, 1744]
depends_on: []
sprint: 59
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
