---
id: 3898
title: "perf-bench: string benchmarks on performance.html measure V8's loop-invariant hoisting, not string speed — several 'Wasm is slower' bars are artifacts"
status: done
created: 2026-07-31
updated: 2026-07-31
completed: 2026-07-31
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: performance
sprint: current
horizon: m
es_edition: n/a
related: [1009, 1949, 3899, 3900, 3901]
---

# #3898 — the perf-page string benchmarks measure V8's LICM, not string performance

## Status: DONE — benchmarks corrected, baselines re-derived (2026-07-31)

**Jump to [Results](#results--corrected-baselines-2026-07-31) for the corrected
numbers.** Headline: `string/substring` **reverses** (20.29x slower → 3.61x
faster), `string/indexOf` and `string/includes` shrink by ~6x, `case-convert`
shrinks by ~130x but remains a real 127x deficit. Read the
[noise floor](#noise-floor--what-is-and-is-not-a-real-change) caveat before
treating any sub-2x change as signal.

## Problem

`https://js2.loopdive.com/benchmarks/performance.html` renders
`benchmarks/results/latest.json`. Several JS baselines in that file report
times that are **physically impossible**, so the published "Wasm is N× slower
than JS" bars for those benchmarks are not measuring what the page claims.

From the 2026-07-31 run, `avgMs` per `run()` call:

| Benchmark             | JS avgMs   | work claimed per call                  | implied per-op cost |
| --------------------- | ---------- | -------------------------------------- | ------------------- |
| `string/indexOf`      | 0.0015575  | 1000 × `indexOf` over a 10,000-char haystack | **1.56 ns**   |
| `string/includes`     | 0.0017079  | 1000 × `includes` over 10,000 chars    | **1.71 ns**         |
| `string/substring`    | 0.0024751  | 10,000 × `substring(5, 20)`            | **0.25 ns**         |
| `string/case-convert` | 0.00025358 | 2000 × `toLowerCase`/`toUpperCase`     | **0.13 ns**         |

A single `indexOf` scan over 10 KB cannot complete in 1.56 ns — that is under
5 clock cycles at 3 GHz for a 10,000-character search.

## Root cause — confirmed by measurement, and it is NOT dead-code elimination

The obvious hypothesis is "the baselines return `void` and discard their
accumulator, so V8 DCEs the loop." **That hypothesis is wrong**, and acting on
it would produce a fix that changes nothing. Measured with
`.tmp/dce-probe.mjs` (each shape run as `(): void` with the result discarded,
vs. the identical body returning its accumulator into a global sink):

```
name               void(ms)   returned(ms)     ratio
indexOf            0.005123       0.003865      0.75
includes           0.003381       0.003639      1.08
substring          0.005635       0.008097      1.44
caseConvert        0.000674       0.000714      1.06
```

Returning and consuming the result changes nothing. The work is still gone.

The actual cause is **loop-invariant code motion**. Every one of these
benchmarks calls a pure `String.prototype` method with a **constant receiver
and constant arguments** inside the loop:

```ts
const haystack = "abcdefghij".repeat(1000);
for (let i = 0; i < 1000; i++) sum = sum + haystack.indexOf("fghij");
//                                        ^^^^^^^^^^^^^^^^^^^^^^^^^ same value every iteration
```

TurboFan hoists the call out of the loop and runs it **once**, then multiplies.
Confirmed by varying the argument so hoisting is impossible
(`.tmp/dce-probe2.mjs`):

```
invariant  0.004654      // haystack.indexOf("fghij")           — hoisted, ~1 scan
varying    0.029199      // haystack.indexOf("fghij", i*7%5000) — 6.3× more, ~29 ns/scan
subInv     0.008959      // s.substring(5, 20)                  — hoisted
subVar     0.108931      // s.substring(i%5, 20)                — 12.2× more, ~10.9 ns/call
ccInv      0.001032      // s.toLowerCase()/.toUpperCase(), result consumed — still ~0.5 ns/call
```

With a varying argument the per-op costs land at realistic values (29 ns for a
10 KB scan, 10.9 ns for a 15-char substring copy). With the constant argument
the loop collapses. `ccInv` shows `toLowerCase`/`toUpperCase` stay hoisted even
when the result is consumed, because the receiver is a literal.

So on these four benchmarks the page compares **"V8 hoisted the call and ran
it once"** against **"js2wasm ran it 1000 times"**.

## Consequence — the numbers may flip, not just shrink

For `string/indexOf`, the gc-native lane measures 0.0149466 ms per `run()` =
**14.9 ns per scan**. An honest JS baseline costs **29 ns per scan**. If
js2wasm is not itself hoisting, gc-native is roughly **2× faster than JS** on
this workload — while the public page currently shows it **9.6× slower**. The
same reversal is plausible for `substring` (5.2 ns gc-native vs 10.9 ns honest
JS).

This is not a small correction. The page is likely understating js2wasm on
exactly the benchmarks it flags as worst.

## Which benchmarks are affected

**Confirmed invalid** (JS baseline is hoisted; must be fixed before any
conclusion is drawn): `string/indexOf`, `string/includes`, `string/substring`,
`string/case-convert`.

**Confirmed valid** (JS per-op costs are realistic — 10-31 ns — so real work
is happening): `string/trim`, `string/startsWith-endsWith`, `string/split`,
`string/replace`, `mixed/csv-parse`, and the array/mixed numeric benchmarks.

**Needs checking**: `mixed/text-search` — its baseline consumes its result and
reports ~21 ns per iteration for 4 string ops, which is low enough to suspect
partial hoisting even though it is clearly not fully collapsed.

## Acceptance criteria

1. Every string benchmark's inner loop uses an input that **varies with the
   loop induction variable**, in **both** the JS baseline and the paired Wasm
   `source` string, so neither engine can hoist. The two lanes must remain
   semantically equivalent — same operation, same number of executions, same
   accumulated result.
2. Baselines return their accumulator and the harness sinks it
   (`benchmarks/harness.ts` / `benchmarks/timing.ts`). This is not sufficient
   on its own (see above), but it removes the weaker DCE risk and lets the
   harness assert the two lanes agree.
3. Add a **cross-lane result assertion**: after warmup, compare the JS
   baseline's return value against the Wasm `run()` return value and fail the
   benchmark loudly if they differ. That is what would have caught this.
4. Add a **plausibility guard** to `benchmarks/report.ts`: flag any lane whose
   implied per-operation cost is below ~1 ns and refuse to publish it as a
   valid comparison. A benchmark that reports the impossible should not
   silently reach the public page.
5. Re-run `npx tsx benchmarks/run.ts`, regenerate `latest.json`/`history.json`,
   and record the corrected ratios in this issue — explicitly stating which of
   the 14 currently-"slower than JS" entries survive, which shrink, and which
   **reverse**.
6. `.tmp/dce-probe.mjs` and `.tmp/dce-probe2.mjs` are scratch; promote the
   varying-vs-invariant check into a real regression test if it is cheap to do.

## Notes

- Do **not** equalise the lanes by making the Wasm source discard its result
  or by adding hoisting to js2wasm to match. Fix the benchmark inputs. If we
  later want to measure LICM, that is a separate, honestly-labelled benchmark.
- js2wasm has its own LICM pass (#1200). Once the inputs vary, check whether
  js2wasm hoists them too — if it does, the comparison stays fair; if it does
  not, that is a real optimisation opportunity, but it must not be conflated
  with string-kernel cost.
- This is the concrete, data-driven follow-up to the analysis-only #1009, and
  it invalidates the specific ratios quoted in #1949 (`string/split 4.9×`,
  `case-convert 115×`) as gate inputs until re-derived.
- **This issue gates #3899, #3900 and #3901.** Those three must re-measure
  against corrected baselines before claiming a win.

---

## Implementation

### What changed

| File | Change |
| --- | --- |
| `benchmarks/suites/strings.ts` | Every inner loop now depends on the induction variable. `indexOf`/`includes`/`substring` take a position argument derived from the counter; `split`/`replace`/`toLowerCase`/`toUpperCase`/`trim`/`startsWith`/`endsWith` index an 8-entry table of distinct receivers. All baselines return an accumulator folding in every iteration. |
| `benchmarks/suites/mixed.ts` | Same treatment for `mixed/text-search` (was fully loop-invariant) and the outer `csv.split("\n")` in `mixed/csv-parse`. All baselines return accumulators. `mixed/fibonacci` folds modulo a prime — see the i32-overflow finding below. |
| `benchmarks/harness.ts` | `BenchmarkDef.js` returns `number \| void`; new `opsPerCall` / `minNsPerOp` fields; new `nsPerOp` / `implausible` result fields. **Cross-lane assertion**: after warmup, each Wasm lane's `run()` return value is compared against the JS baseline's; a mismatch prints a banner, drops the lane and sets a non-zero exit code. |
| `benchmarks/timing.ts` | `timeBenchmarkBatch` sinks the return value instead of discarding it. |
| `benchmarks/report.ts` | **Plausibility guard** `flagImplausibleLanes()`: any lane below `max(1 ns, minNsPerOp)` per operation is marked `implausible`, excluded from the speedup columns (`⚠ implausible`), listed in a warning section at the top of the report, and sets a non-zero exit code. New "Cost per operation (ns)" table. |
| `tests/issue-3898.test.ts` | 12 tests: the guard flags the historical impossible numbers, the guard's universal floor alone would have missed `string/indexOf`, every def declares `opsPerCall`, every baseline returns a finite accumulator, no baseline is fast enough to be impossible, and Wasm `run()` matches the JS baseline for the four benchmarks named invalid above. |

### Two design decisions that are load-bearing

**1. Variant tables are written as literals, not derived with `substring`.**
The first attempt built them as `base.substring(0, base.length - v * step)`.
That is wrong: V8 represents a substring of a long-enough string as a
`SlicedString`, and `split`/`trim`/`replace` must flatten one before operating.
It inflated the JS lane by 3-18x (`string/split` js went 0.248 ms → 4.426 ms)
and would have traded one benchmark artifact for another — measuring V8's string
representation instead of the operation. Flat literals give
`string/split` js 0.632 ms.

**2. `startsWith`/`endsWith` vary the receiver, not the position.**
`s.startsWith("hello", i % 3)` does defeat hoisting, but 2 of every 3 calls then
mismatch on the first character and return early — silently deleting two-thirds
of the work from **both** lanes. The 8 receivers in `STARTS_ENDS_VARIANTS` all
start with `"hello"` and end with `"benchmarking"`, so all 20,000 comparisons
stay full-length and matching and the accumulated result is unchanged from the
pre-#3898 workload. Same reasoning for `mixed/text-search`.

`indexOf`/`includes`/`substring` keep the position-argument form because the
match still succeeds there and the scan length is unchanged.

### The universal 1 ns floor was not enough (AC 4)

AC 4 asks to flag anything under ~1 ns/op. That floor alone would **not** have
caught this bug: the hoisted `string/indexOf` baseline reported **1.5575 ns/op**,
which clears 1 ns, yet the honest cost is ~30 ns. So the guard is
`max(MIN_PLAUSIBLE_NS_PER_OP, def.minNsPerOp)` — a universal physical bound plus
a per-benchmark floor set to roughly a quarter of the honest measured cost. A
collapsed loop is 20x+ too fast, not 4x, so the margin is safe against a faster
machine. `tests/issue-3898.test.ts` pins both halves, including an explicit test
that the universal floor alone misses `string/indexOf`.

### Finding: the cross-lane assertion caught a real compiler defect on its first run

```
!! CROSS-LANE MISMATCH in "mixed/fibonacci" [gc-native]
   js baseline returned 8320400000, wasm run() returned -269534592.
```

`fib(30)` is 832,040 and the loop runs 10,000 times, so the sum reaches 8.32e9 —
past 2^31. **The gc-native (fast-mode) lane infers i32 for the accumulator and
wraps**, while JS, host-call and linear-memory all carry it in f64. That lane was
therefore comparing wrapping i32 adds against f64 adds, and had been doing so
silently: the old JS baseline discarded its result, so nothing ever compared the
two. Worked around here by folding modulo 1000000007 (keeps every lane exact and
in i32 range). **The underlying fast-mode integer-width inference bug is not
fixed and deserves its own issue.**

---

## Results — corrected baselines (2026-07-31)

`benchmarks/results/latest.json` / `latest.md` / `history.json` regenerated from
a **full-suite** run (`npx tsx benchmarks/run.ts`, 2026-07-31T13:02:21Z, Node
v22.22.2, linux x64). No lane was flagged implausible and no cross-lane mismatch
remained.

### Noise floor — what is and is not a real change

The box ran at load average ~13 on 4 cores throughout (six agents sharing it).
Absolute milliseconds are contention-inflated and should not be quoted.

The noise floor can be measured directly, because three benchmarks were **not
semantically changed** yet still moved:

| Unchanged benchmark | before | after | drift |
| --- | --- | --- | --- |
| `string/concat-short` | 1.11x slower | 1.32x slower | 1.19x |
| `string/concat-long` | 1.00x slower | 1.45x slower | 1.45x |
| `mixed/matrix-multiply` | 1.01x slower | 1.82x slower | 1.80x |

**So a ratio change under ~1.8x is indistinguishable from measurement noise on
this box.** Ratios below are the **median of 6 runs** (strings; 3 runs for
arrays/mixed, which only ran in the full-suite passes) with the observed range.

### The 14 entries where JS beat every Wasm lane

| Benchmark | before (gc/js) | after (median of 6) | range | verdict |
| --- | --- | --- | --- | --- |
| `string/substring` | 20.29x slower | **3.61x FASTER** | 2.41x–6.05x faster | **REVERSED** — 73x swing |
| `string/case-convert` | 16,598.99x slower | 127.64x slower | 96.6x–215.7x | **SHRANK 130x** (still the worst real gap) |
| `string/includes` | 7.88x slower | 1.20x slower | 1.70x slower–1.05x faster | **SHRANK 6.6x** — now at parity |
| `string/indexOf` | 9.34x slower | 1.68x slower | 1.09x–2.34x | **SHRANK 5.6x** |
| `string/concat-short` | 1.11x slower | 1.32x slower | 1.75x slower–1.08x faster | no change (noise) |
| `string/replace` | 3.27x slower | 3.39x slower | 2.89x–5.65x | no change |
| `string/trim` | 4.42x slower | 5.14x slower | 3.90x–7.15x | no change (noise) |
| `string/startsWith-endsWith` | 7.67x slower | 6.30x slower | 3.74x–8.32x | shrank, within noise |
| `string/split` | 3.42x slower | 6.01x slower | 4.87x–8.83x | **GREW 1.76x** — at the noise floor, treat as "no reliable change" |
| `mixed/csv-parse` | 2.80x slower | 3.01x slower | 1.20x–3.88x | no change |
| `mixed/text-search` | 5.19x slower | 6.54x slower | 4.79x–7.97x | no change (1.26x < floor) |
| `mixed/matrix-multiply` | 1.01x slower | 1.82x slower | 1.16x–1.84x | unchanged benchmark — pure noise |
| `array/sort-i32` | n/a | n/a | — | no gc-native lane (`illegal cast` at runtime) |
| `array/find` | n/a | n/a | — | no gc-native lane (`local.set` type error) |

**Summary against AC 5:** of the 14, **1 reverses** (`string/substring`),
**3 shrink materially** (`case-convert` 130x, `includes` 6.6x, `indexOf` 5.6x),
**2 have no gc-native lane at all**, and the remaining **8 survive unchanged**
once the noise floor is respected. Nothing grew by more than the noise floor.

After the fix, JS still beats every Wasm lane on 13 benchmarks (was 14);
`string/concat-short` and `string/substring` left the set, `string/concat-long`
entered it.

### Per-operation costs — the sanity check that was missing

Every JS baseline now lands in a physically possible range. Compare against the
impossible "before" column that motivated this issue:

| Benchmark | JS ns/op BEFORE | JS ns/op AFTER | gc-native ns/op AFTER |
| --- | --- | --- | --- |
| `string/indexOf` | **1.56** (impossible) | 29.82 | 50.06 |
| `string/includes` | **1.71** (impossible) | 31.14 | 40.06 |
| `string/substring` | **0.25** (impossible) | 14.60 | 4.22 |
| `string/case-convert` | **0.13** (impossible) | 77.34 | 6,759.89 |
| `string/split` | — | 63.17 | 454.69 |
| `string/replace` | — | 110.13 | 390.78 |
| `string/trim` | — | 58.38 | 245.54 |
| `string/startsWith-endsWith` | — | 42.85 | 239.22 |
| `mixed/csv-parse` | — | 66.31 | 220.00 |
| `mixed/text-search` | — | 16.58 | 101.71 |

The corrected `string/indexOf` JS cost of **29.82 ns/op** matches the 29 ns the
issue predicted from `.tmp/dce-probe2.mjs` almost exactly — independent
confirmation that the varying-argument form is measuring the real scan.

### What this means for #3899 / #3900 / #3901

- **`string/substring` is no longer a deficit.** js2wasm is ~3.6x faster than V8
  there. Note V8 returns a `SlicedString` (O(1)) where js2wasm copies, so this
  win is real but the workloads differ in allocation behaviour.
- **`string/indexOf` and `string/includes` are at or near parity** (1.7x / 1.2x).
  Any optimisation work targeting them should be re-justified: the 9.3x and 7.9x
  headline deficits were ~80% artifact.
- **`string/case-convert` is the one genuinely catastrophic lane**: 6,760 ns to
  case-convert a 23-character string, versus 77 ns in V8. That 127x is real.
- **`string/split` (455 ns/op) and `string/trim` (246 ns/op)** remain real
  multi-x deficits and are the next most valuable targets after `case-convert`.
- The `host-call` lane is 20x–90x slower than JS across every string benchmark
  and is unaffected by this correction.

### Caveats

1. Absolute times are contention-inflated; only ratios are meaningful, and only
   above the ~1.8x noise floor established above.
2. `benchmarks/results/latest.json` is a single full-suite run. The
   median-of-6 ratios in the table above are the more reliable figures and do
   not always match the single run in `latest.json`.
3. `array/*` and `dom/*` baselines still return `void`, so they get no
   cross-lane assertion and no `opsPerCall`. The machinery is in place; wiring
   them up was left out to keep this change scoped to the string benchmarks the
   issue named.
4. The `implausible` flag is written into `latest.json` but the public
   `performance.html` does not yet render it. `report.ts` refuses to publish the
   ratio and fails the run, which is the gate AC 4 asked for; surfacing it on the
   page is a follow-up.

## Test Results

- `npx vitest run tests/issue-3898.test.ts` — **12 passed**.
- `npx tsc --noEmit` — clean.
- `npx tsx benchmarks/run.ts` (full suite) — no cross-lane mismatch, no
  implausible lane, exit 0.
