# Standalone gap map — audit 2026-07-12 (architect)

Grounded against `upstream/main @ adc65cfc65` and the fresh standalone baseline
(`test262-standalone-current.jsonl`, generated 2026-07-12, oracle v2, 48,088
distinct files). Report built via
`node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --target standalone`.

## The number that matters

Official scope (standard + annex_b, 43,106 tests):

| Metric | Value |
| --- | --- |
| pass (any) | 25,341 (58.8 %) |
| **host_free_pass (the standalone bar)** | **20,885 (48.4 %)** |
| **leaky_pass** (passes only via host-import shims) | **4,456 (10.3 pts!)** |
| fail | 16,396 |
| compile_error | 1,339 |

Porffor's ~61 % is measured on the host-free axis. Our gap to porffor is
**~12.6 pts ≈ 5,430 tests**. The leaky-pass column alone is 10.3 pts — the
single largest lever, and it is almost entirely ONE feature family (below).

## Where the 4,456 leaky passes come from (imports field, official scope)

| Host import family | leaky tests touching it | Root cause | Tracking |
| --- | ---: | --- | --- |
| `__get_caught_exception` | 4,108 | registered alongside every host-path generator (index.ts:11798); disappears when gen coverage is native | rides #3164/#3132 |
| `__gen_create_buffer`/`__gen_next`/… (sync eager-buffer machinery) | ~4,011 | generator shapes that bail `isNativeGeneratorCandidate` | **#3164 (NEW)** = function EXPRESSIONS (dstr harness `var iter = function*(){…}()`); ~1,741 sync leaks |
| `__create_async_generator` + `__make_callback` | 2,409 / 2,263 | async generators still host-driven | #3132 (in-progress, XL) |
| `Promise_then2/resolve/reject/then` | ~1,500 | host-backed Promise builtin methods | #2903 (ready — should be scheduled) |
| `__dynamic_import` | 155 | dynamic import | #1089/#1512 (deferred) |
| long tail (`__js_array_*`, `DisposableStack_*`, …) | <100 each | misc | — |

**Sequencing note:** #3164 (sync gen exprs) + #3132 (async gens) + #2903
(Promise methods) together retire ~90 % of the leaky-pass column. They are
independent and can run in parallel; #3164 is the smallest and most
mechanical of the three.

## Where the 16,396 official-scope fails come from (root_cause_map, fresh)

Ranked by count; "cited issue" = what the codegen self-cites — many are
`done`, meaning the residual needs a NEW owner:

| Bucket | Count | Cited issues (status) | Live owner / gap |
| --- | ---: | --- | --- |
| class-prototype-private-descriptor | 6,362 | #1591/#1365/#1364 (all done) | heterogeneous; biggest single-cause slices: dstr → #2040; **computed-name class fields → #3166 (NEW, 150 tests, verified)**; subclass-builtins → #2622 (backlog) |
| standalone-iterator-protocol | 2,777 | #1665/#681/#1718 (all done) | dominated by gen-meth/async dstr → #2040 + #3132; iterator helpers → #3146 (ready) |
| object-property-semantics (+ dynamic-object-property) | 1,722 + 947 | #1472 (done) | #2515 / #3053 / #3037 (in-progress substrate track) |
| honest-vacuity reclassification | 781 | #2940 (done), #3086 (in-progress) | #3086 |
| eval / new Function + annexB eval | 768 + 685 | #1066/#1073/#1594 | largely deferred (dynamic code) |
| array-typedarray-buffer | 638 | #1358/#1461/#1654 (done) | **~186 tests are the arguments-capture readback bug → #3165 (NEW, verified)**; resizable-buffer/SAB tail |
| generator-async-iteration | 265 | #680/#1665 (done) | #3132 / #3164 |
| standalone RegExp (all sub-buckets) | ~533 | #1909–#1914, #2723 (ready) | #2723 |
| everything else | <200 each | — | tail |

Cross-check: `#2040` (dstr runtime semantics, ~1,750 tests, priority critical)
is `in-progress` with `updated: 2026-06-22` and `sprint: 64` — **stalled ~3
weeks**. It carries a finished diagnosis (rest-identity aliasing). Recommend
re-tagging `sprint: current` and releasing the stale claim.

## Ranked action list (standalone lane)

| # | Lever | Est. host-free Δ | Class |
| - | --- | ---: | --- |
| 1 | #3132 async-gen native (in-progress) | ~2,300 leaky→free + fails | in-flight |
| 2 | **#3164 gen function-expression native (NEW)** | ~1,700 leaky→free | fable-executable-now |
| 3 | #2903 Promise method self-host (ready, schedule it) | ~1,500 leaky→free (overlaps 1) | fable-executable-now |
| 4 | #2040 dstr rest-identity + next() order (stalled — restaff) | ~1,000+ fails | fable-executable (diagnosis done) |
| 5 | #3053/#3037 dynamic-reader substrate (in-progress) | ~1,500 fails | opus-owned (substrate) |
| 6 | **#3165 arguments-capture indexed readback (NEW)** | ~186 fails | fable-executable-now |
| 7 | **#3166 class computed-name fields/accessors (NEW)** | ~150 fails | fable-executable-now |
| 8 | #2723 native RegExp engine (ready) | ~500 fails | opus-owned (engine design) |

## IR-first flip (#3143) blocker list — audit 2026-07-12

Verified live: under `JS2WASM_IR_FIRST=1`, functions in the skip set whose
IR build later throws are **hard compile errors** (codegen/index.ts:2147–2172
"never a silent legacy demote"). Selector REJECTS (body-shape-rejected etc.)
are *not* in the skip set — they keep legacy bodies and are safe. Therefore
**the flip gate is zero post-claim demotions, not #2856's bucket-to-zero.**

Residual post-claim divergence classes (#3153 census, minus #3156 which
landed):

| Class | Fix | Status |
| --- | --- | --- |
| string relational `<
> <= >=` | **#3167 (NEW, impl plan)** | fable-executable-now |
| unary `+`/`-` ToNumber on non-number | **#3168 (NEW, impl plan)** | fable-executable-now |
| TypedArray-view element store | mirror in selector (reject pre-claim) — folded into #3143 plan | trivial once specced |
| ~~substring/charCodeAt family~~ | #3156 | done 2026-07-12 |

Payoff: G1 of `plan/log/3090-phase0-legacy-delete-list.md` — **~60.0K
legacy-only fn-lines** become deletable (Phase 3a).
