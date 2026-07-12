# 2026-07-12 — Final holistic codebase audit (Fable)

**Scope**: whole-codebase priority audit — what matters MOST that is NOT already
tracked. Evidence base: fresh default-lane baseline
(`scripts/fetch-baseline-jsonl.mjs`, fetched 2026-07-12 → 48,119 entries;
official scope 43,137, pass 32,937 = **76.4 %**; non-pass = 9,841 fail + 257
compile_error + 83 compile_timeout + 19 skip = **10,200**), plus targeted greps
of `src/` and `tests/`. All counts below are official-scope, default (JS-host)
lane unless stated.

**Deliberately NOT re-covered** (already tracked): standalone-gap slices
#3169–#3181 + umbrella #2860/#3178; bloat epic #3182 (+ #3090/#3102–#3114);
soundness #3162/#3179/#3183; IR retirement #2855/#3090/#3142/#3143;
clean-architecture #3029/#3030/#2141; class-elements #3021 (~1,522, the
largest tracked bucket, in-progress); defineProperty #3022; dynamic import
#1089 (ready, 429 tests); ArrayBuffer.transfer #1595 (blocked); eval/with —
deferred by policy.

---

## Executive summary — top 5 priorities

**1. The default-lane async "vacuous" family (1,544 fails, ~3.6 pts) is
treated as measurement bookkeeping, not as a fix target.** The single biggest
error bucket in the entire default-lane fail set is `vacuous: harness-wrapper
callback never executed (#2940)` — 1,544 records. The honest-reclassification
work (#2940/#3086/#3001) made these *visible*; nothing open *fixes* the two
biggest slices: **for-await-of (383)** and **Promise-combinator callbacks
(218)** on the HOST lane. Every open async carrier issue (#2865/#2867/#2906/
#3132/#3178) is standalone-lane; #2613/#2614 (host-lane await/combinators) are
*blocked* and cover only ~60 of these. These are silent no-op async paths —
compiled code that runs, does nothing, and reports success. Filed: see §F1.

**2. Default-lane `built-ins/Array` is the largest untracked builtin bucket
(1,057 fails) — the 2026-07-03 harvest skipped it.** reduce/reduceRight (178),
map/filter (137), splice (63), some/forEach/every (158), indexOf/lastIndexOf
(98), slice/sort/concat (138). Error shapes show three mechanisms: array-like
receivers via `Array.prototype.X.call(obj)`, observable-semantics gaps
(`accessed !== true`, getter/hole observation), and 30 hard traps (16
illegal_cast + 14 OOB). The standalone twins are tracked (#3169/#3170/#3180,
#2036); the host lane has **no open issue**. Filed: see §F2.

**3. Silent-wrong-value siblings of #3179 (boxed string-index family) are
unfiled — and strictly worse than the trap variant.** #3179's own ablation
documents that the gc/host lane on the same repro "does not trap — returns
wrong value". The trap variant got filed; the silent-wrong-value variant did
not. A compiler that silently computes the wrong value on `for (k in arr) …
arr[k]` is a bigger trust problem than one that traps, and it is invisible to
trap-census tooling. Filed: see §F3, plus a recommended family census
(string-keyed reads AND writes, vec + TypedArray receivers, both lanes).

**4. The test262 `error_category` taxonomy mis-bins ~80 % of "wasm_compile" —
distorting every harvest and the #3024 sizing.** 448 non-pass records carry
`error_category: wasm_compile`, but only ~87 are genuine invalid-Wasm
(`invalid Wasm binary…`). The classifier regex at `tests/test262-runner.ts:4241`
(`/Compiling function|No dependency provided|not a function/i`) sweeps
missing-builtin failures (`safeBroadcast is not a function` ×56,
`transferToImmutable…` ×38, `sumPrecise` ×5) and the compiler's own
`No dependency provided for extern class "X"` diagnostic (×61) into the
invalid-Wasm bucket. Cheap fix, big triage payoff. Filed: see §F4.

**5. ES module-code semantics have zero live tracking (174 fails + the whole
`language/module-code` surface).** Namespace-object semantics, cross-module
TDZ, 17 undetected module early errors, and harness-wrapping artifacts
(`Duplicate export name 'test'` ×6). Only ancient #34 (multi-memory linker),
#2971 (TLA sibling eval) and #1512 (dynamic-import early errors) graze this
surface. With dynamic-import already tracked (#1089, 330 more fails), modules
are the last whole-ES-surface with no umbrella. Filed: see §F5.

---

## F1 — Default-lane async vacuous family (1,544; largest single bucket)

### Evidence

Baseline error-shape census (top shape of ALL non-pass records):

```
1544  "vacuous: harness-wrapper callback never executed (#N) — no assertio…"
```

Decomposition by path (top 15):

| path | vacuous count |
|---|---|
| language/statements/for-await-of | **383** |
| language/expressions/dynamic-import | 234 (tracked → #1089) |
| annexB/language/eval-code | 168 (deferred policy — eval) |
| language/expressions+statements/class | 180 (→ #3021 surface) |
| built-ins/Promise/{any,race,all,allSettled,prototype} | **218** |
| language/{expressions,statements}/async-{function,generator} | ~91 |
| language/eval-code/direct | 40 (deferred) |

The runner DOES implement the async protocol (`$DONE` at
`tests/test262-runner.ts:1890`, `asyncTest` at `:1899`, detection at
`:2568-2569`) — so these are compiler-side: the async callback chain never
runs. Total for-await-of fails: **489** (383 vacuous + 18/17/12 sameValue
shapes + 5 null-deref + 3 invalid-wasm) — sampled files are dominated by
`async-{func,gen}-dstr-*` destructuring-in-async patterns.

### Why it matters

These are *silent no-op* paths: the compiled program returns success while the
test body's assertions never execute. Beyond the 3.6-pt conformance mass, this
is the same hazard class as F3 (silent wrong behavior). It is also the
biggest coherent chunk of the 5,615 `assertion_fail` + 2,866 `other` residual.

### Tracking gap

- #2940/#3086/#3001/#3004 — *measure* the vacuity honestly; no fix scope.
- #2613 (await thenable, ~15) and #2614 (combinator resolve, ~45) — host-lane,
  but **blocked**, and cover < 60 of the 1,544.
- #2865/#2867/#2895/#2906/#3132/#3178 — all standalone-lane carriers.
- #2669 — destructuring umbrella; mentions 15 for-await dstr regressions, not
  the 383-record vacuous class.

**Filed**: #3184 (default-lane for-await-of / async-dstr vacuous cluster,
P1) and the audit recommends un-blocking or re-slicing #2614 for the
Promise-combinator 218.

---

## F2 — Default-lane Array.prototype generics/observability cluster (1,057)

### Evidence

Largest built-ins bucket on the default lane (vs Object 718 → #3022,
TypedArray 482, Promise 322). Sub-buckets:

```
90 reduceRight   88 reduce   69 map   68 filter   63 splice
54 some   53 forEach   51 every   50 lastIndexOf   48 indexOf
48 slice   45 sort   45 concat   14 flatMap   13 pop
```

Top error shapes across the 13 HOF/search methods:

```
111  assert(testResult, 'testResult !== true')        ← callbackfn semantics
 33  assert(accessed, 'accessed !== true')            ← accessor observation
 28  newArr.length mismatch                            ← species/length
 21  "object is not a function"                        ← callable mis-dispatch
 16  illegal cast [in test()]                          ← trap (uncatchable)
 14  array element access out of bounds [in test()]    ← trap (uncatchable)
 13+13+12+7  Array.prototype.X.call(array-like) shapes ← generics receivers
```

Code anchor: the array-like (externref receiver) path exists —
`ARRAY_LIKE_METHOD_SET` in `src/codegen/array-methods.ts:668` (file is 9,632
LOC) with documented exclusions and thisArg handling (`:692`) — but the
observable-semantics contract (get/has ordering, holes, accessor observation,
length clamping, species) is what these tests check and what the current
lowering shortcuts.

### Tracking gap

#3169/#3170/#3180/#2036 are all `--target standalone`. #1589A covers 2
compile-timeout tests. The 2026-07-03 harvest filed class/defineProperty/
iterator/invalid-wasm/with/negative buckets but **not** Array. No open
default-lane Array issue exists (verified by title grep over
`plan/issues/*.md` open statuses).

**Filed**: #3185 (umbrella, P1) — slice by mechanism, not by method.

---

## F3 — Silent-wrong-value siblings of the boxed-index family (#3179)

### Evidence

#3179 (standalone `for (var k in arr)` + `arr[k]` → illegal-cast trap) records
in its own problem statement, from ablation:

> `gc`/host lane does not trap (**returns wrong value** — a separate
> correctness gap — but no illegal-cast).

That "separate correctness gap" was never filed. On the host lane the same
minimal repro returns a wrong `s.length` — silently. Adjacent baseline
evidence on the same mechanism family:

```
fail language/statements/for-in/order-after-define-property.js   (wrong keys)
fail language/statements/for-in/S12.6.4_A3.js                    (__str is not defined)
fail language/statements/for-in/scope-head-var-none.js           (null deref)
```

### Why it matters

Trap-class bugs self-announce (they even have their own error categories:
null_deref 184, illegal_cast 88, oob 57, unreachable 20 — 349 total).
Silent-wrong-value bugs do not — they surface only when a downstream
assertion happens to compare the value, and they are exactly the class that
erodes trust in a compiler. The string-keyed-index mechanism (an index that is
a *string* at runtime flowing into a numeric-index lowering) plausibly has
siblings beyond for-in: `Object.keys(arr)` loops, literal `arr["0"]`,
string-keyed *writes*, TypedArray receivers. Nobody has censused the family.

**Filed**: #3186 (host-lane silent-wrong-value for-in string-key element read,
sibling of #3179, high) — acceptance includes a short family census (reads +
writes × vec/TypedArray × both lanes) so remaining siblings get filed with
measured counts rather than discovered one JSON bucket at a time.

---

## F4 — `error_category` taxonomy: `wasm_compile` is 80 % mislabeled

### Evidence

448 records carry `error_category: "wasm_compile"`; shape census:

```
 56  safeBroadcast is not a function            ← Atomics harness helper missing
 47  invalid Wasm binary (…Compiling functi…)   ← GENUINE
 44  safeBroadcastAsync is not a function       ← missing builtin
 40  invalid Wasm binary (…Compiling functio…)  ← GENUINE
 38  object is not a function                   ← callable mis-dispatch
 34  No dependency provided for extern class "BigInt"
 22  undefined is not a function
 22  No dependency provided for extern class "FinalizationRegistry"
 38  transfer/transferToImmutable/transferToFixedLength is not a function (#1595)
 10  then is not a function
  5  sumPrecise is not a function               ← Math.sumPrecise missing
```

Genuine invalid-Wasm ≈ 87; the rest are missing-builtin / dependency-injection
diagnostics. Root cause: `tests/test262-runner.ts:4241`

```ts
if (/Compiling function|No dependency provided|not a function/i.test(errorMsg)) return "wasm_compile";
```

`not a function` and `No dependency provided` are NOT Wasm-validation
failures. Consequences: (a) #3024 ("invalid Wasm residual, ~131") is sized off
a polluted bucket; (b) every `/harvest-errors` sweep and `/analyze-regression`
bucket-by-category report misroutes ~360 records; (c) a real invalid-wasm
regression can hide inside missing-builtin noise in the merge-gate bucket
analysis (bucket >50 escalation rule keys off these categories).

**Filed**: #3187 (split the classifier: `missing_builtin` +
`missing_dependency` out of `wasm_compile`, easy) — with an oracle-version
note per #3003 (verdict-logic changes must bump `oracle_version`).

---

## F5 — ES module-code semantics: last untracked whole-surface (174)

### Evidence

`language/module-code` — 174 non-pass. Shapes:

```
 26+26  returned N / ConformanceError            ← semantics wrong
 17     expected SyntaxError, no diagnostic       ← module early errors unenforced
 14     [object WebAssembly.Exception]
 10     Cannot access property on null/undefined
  9+2   assert.throws(ReferenceError …)           ← cross-module TDZ
  6     Duplicate identifier 'test' / Duplicate export name 'test'  ← harness wrap artifact
  5     Reflect.has called on non-object          ← namespace object
  4     No dependency provided for extern class "C"
```

Plus `language/expressions/dynamic-import` 330 (tracked: #1089 ready) — i.e.
the module surface in total is ~500 tests, of which the static-module half has
no umbrella. The `Duplicate export name 'test'` rows are a *runner* bug
(wrapTest collides with a test's own `test` export), worth 30 minutes inside
the same issue.

**Filed**: #3188 (module-code semantics umbrella, medium, backlog-scale with
one ready first slice: module early errors + wrapTest export collision).

---

## Minor findings (doc-only, no issue filed)

- **Trap discipline as a ratchet**: 349 default-lane fails are uncatchable
  traps (null_deref 184, illegal_cast 88, oob 57, unreachable 20). Individual
  issues fix instances; there is no CI ratchet keeping the *category counts*
  monotonically falling the way `check:ir-fallbacks` ratchets fallbacks. If
  the trap counts regress-while-net-positive on a PR, nothing notices. Cheap
  candidate: extend the existing bucket analysis to hard-fail on
  trap-category *growth*. (Related goal: crash-free.) **Filed after all:
  #3189** — the mechanism is cheap and reuses the #2855/#3102 ratchet pattern.
- **Compile-time perf is healthy, but ungated**: baseline `compile_ms` p50
  102 ms / p90 316 ms / p99 1,385 ms / max 10 s (87 tests > 5 s; 2.3 CPU-hours
  per full run). No trend gate; god-file refactors (#3104/#3111) could
  regress it invisibly. Suggest recording p50/p95 in `runs/index.json` (if
  not already) and a soft threshold in the report.
- **Compiler internal errors are rare** (good): only ~5 records are true
  `Internal error compiling …` crashes (e.g.
  `language/statements/for-in/cptn-expr-itr.js`, one
  `Maximum call stack size exceeded`). The `(eval as any)()` overflow class
  (#3005) appears contained.
- **Coverage of load-bearing infra is better than feared**: codegen-linear
  (10,536 LOC) has dedicated tests (`tests/linear-*.test.ts`,
  `tests/ir-vec-two-backend.test.ts`), peephole and optimize likewise. The
  one zero-test module is `src/wit-generator.ts` — peripheral, accept.
- **Error-suppression census**: 10 empty `catch {}` blocks in `src/` — small
  enough to review inside #3107's cast-debt codemod pass.
- **compile_timeout 83** — dominated by class (24), Array/prototype (12),
  object (6); mostly same roots as #3021/F2.

## Method note

Counts reproducible via `node scripts/fetch-baseline-jsonl.mjs` then the
census one-liners embedded in this audit's PR description. Baseline fetched
2026-07-12 (48,119 entries, 36.4 MB).
