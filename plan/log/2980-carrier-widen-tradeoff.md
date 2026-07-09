# #2980 async-carrier-widen — activation tradeoff (decision document)

**Author:** arch-2980 (architect) · **Date:** 2026-07-09 · **Ground-truth base:**
main @ `e348f55ca` (merge_group run 29035099712, oracle_version 2). Every number
in this document was measured fresh at that SHA — no numbers are carried from
session narratives.

## TL;DR / headline recommendation

**ACTIVATE-WITH-CONDITIONS — the gate should NOT flip today, but the distance
to flip has collapsed from net −51 (2026-07-02) to net +15 on a fresh 322-file
A/B, with exactly ONE substantive residual family blocking it (async-generator
`next(v)`/rejection/`yield*` routing = #2906 slice 3d-iii).** The ratified
mechanical flip criterion (#2980 rule 1: positive total AND no bucket ≤ −2)
fails only on the async-generator bucket (−4) and the class-async supplement
(−2). Land 3d-iii, re-run the recorded A/B, and flip both gates in the tiny PR
rule 1 prescribes. Estimated horizon to a legitimate flip: **one M/L dev slice
(3d-iii) + one S re-measure/flip PR** — this is weeks-of-July work, not a new
substrate program.

Two honesty corrections to the framing this doc was commissioned under:

1. **The "~12k co-leaked rows" deflate to 8,482 unique files, and half of them
   (4,215) already PASS the scored standalone lane** — the widen puts those at
   risk rather than unlocking them. The honest scored-lane upside ceiling is
   **1,372 files** (flag-gated family, standalone-fail today, js-host-pass).
2. **The flag alone converts almost nothing to the host-free metric** (only
   34–474 leaky passes have import sets the flag could fully retire). Its real
   value is as the **keystone that monetizes the entire #2895/#2906 async
   substrate on the scored standalone lane** — today every drive-layer slice
   (3, 3a, 3b, 3d-i, 3d-ii) is wasi-only, and the wasi lane is not scored, so
   that whole investment currently earns zero conformance credit.

---

## 1. Why the flag was deferred (the recorded, measured reasons)

The deferral is not folklore — it is a three-step evidence chain, all verified
present in git/issue files on current main:

1. **AG0 premature widen was a measured net regression (#2865, 2026-06-30).**
   The first widen of `isStandalonePromiseActive` to `ctx.standalone` netted
   **−31** on the async standalone sample (await/async-function area 71→42,
   zero offsetting gain). Root cause (recorded in the predicate's doc comment,
   `src/codegen/async-scheduler.ts:3277-3296`): the `flags:[async]` test262
   harness settles synchronously — an async fn returning a native `$Promise`
   is observed as an undrained struct. The fix class is a real drive layer +
   runner drain hook (PATH B, #2895), not a gate flip. The widen was reverted
   net-0.
2. **The −601 then-chain regression.** The native `.then` lowering had a
   stack-imbalance at corpus scale in async-method-in-class contexts, caught
   only in the `merge_group` (recorded in `isStandaloneThenChainNativeActive`'s
   doc comment, async-scheduler.ts:3315-3331). Both gates were scoped back to
   wasi-only and the rule "flip both together, never piecemeal" was adopted.
3. **The #2980 decision measure (2026-07-02, main @461da1576, commit
   `0213c73e460aa`).** Full construct-bucketed A/B, 262 files: **net −51**
   (+6/−57), decomposed into four residual classes (−18 then-receiver casts,
   −15 for-await drive, −12 async-fn abrupt shapes, −6 async-gen routing). The
   architect ratified **"the gate does NOT flip"** on 2026-07-03 with a
   mechanical re-flip criterion (rule 1: measured positive total net AND no
   construct bucket ≤ −2) and banked the env-var instrument
   (`JS2WASM_ASYNC_CARRIER_WIDEN`, dead code in CI).

So the deferral cost fable-2865/fable-5 found was **correctness regressions on
currently-passing standalone shapes** — not code size, not perf. That was the
right call on the evidence of 2026-07-02.

### What changed since (all landed on main, verified)

| Residual class (07-02)              | Weight | Status on main @e348f55ca                                                              |
| ----------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| 1. `.then` receiver casts           | −18    | **LANDED** — #3035 runtime `ref.test` receiver bridge (07-05; bucket-reg 16→4)         |
| 2. for-await drive                  | −15    | **LANDED (bounded)** — #2906 slices 3/3a/3b (CFG machine, loop back-edges, async-iter) |
| 3. async-fn abrupt/override shapes  | −12    | **partially** — try-throw-finally-return now FIXES in the fresh A/B; rest unlanded      |
| 4. async-gen yield/rejection routing | −6     | **partially** — 3d-i producer + 3d-ii consumer landed; `next(v)`/reject/`yield*` = 3d-iii open |

The 07-02 verdict is therefore **stale as a decision input** — which is what
the fresh measurement below establishes.

---

## 2. Fresh decision measure (2026-07-09, main @e348f55ca)

Instrument verified live first: compiling the same await test flips `wasm_sha`
(`7230c80f…` → `d820571e…`) under `JS2WASM_ASYNC_CARRIER_WIDEN=1`, and both
gates read exactly `ctx.wasi === true` when unset (async-scheduler.ts:3297-3348)
— the issue-file narrative matches the code.

A/B harness rebuilt per the #2980 "Measurement instrument" recipe (construct-
bucketed deterministic spread-sample, `runTest262File(..., "standalone")`,
#2404 drain hook active, separate process per arm). 262 files + a 60-file
**class-async supplement** (the historical −601 blast radius, which the five
original buckets undersample).

| bucket            | n   | off-pass | on-pass | net     | +fixed/−regressed | 07-02 net |
| ----------------- | --- | -------- | ------- | ------- | ----------------- | --------- |
| async-function    | 60  | 32       | 35      | **+3**  | +4 / −1           | −12       |
| for-await-of      | 60  | 14       | 20      | **+6**  | +6 / −0           | −15       |
| async-generator   | 60  | 42       | 38      | **−4**  | +1 / −5           | −6        |
| promise-then-all  | 60  | 18       | 29      | **+11** | +18 / −7          | −18       |
| await-expr        | 22  | 9        | 10      | **+1**  | +1 / −0           | 0         |
| **construct total** | 262 |          |         | **+17** | +30 / −13         | **−51**   |
| class-async (suppl.) | 60 | 45      | 43      | **−2**  | +6 / −8           | (not sampled) |

(Not file-identical to the 07-02 corpus — that harness didn't survive `.tmp/`
— but same recipe, same bucket construction; construct-level comparison is
sound. Raw jsonl + harness recorded in the Method appendix.)

**The sign has flipped: −51 → +17 (+15 including the class supplement).** Also:
compile_error count is unchanged on the widen arm (9→9, 0→0) — **no recurrence
of the −601 invalid-wasm class anywhere in the 322-file sample** — and the
widen arm produced **zero** floating uncaught wasm exceptions vs 17 on the off
arm (the host-Promise path leaks unhandled rejections; the native path does
not).

**But the ratified rule 1 still blocks the flip**: async-generator is −4 and
class-async is −2 (threshold: any bucket ≤ −2 blocks). This is the correct
outcome of the rule working as designed — the regression mass is concentrated
in ONE family:

### The blocking residual, characterized (all 13 regressions traced)

- **async-gen `next()`-promise routing (3d-iii)** — 5 async-generator + 4
  class-async regs: `yield-promise-reject-next*` (a rejected yield operand must
  reject the step promise with correct `done`), `yield-star-next-then-non-
  callable-*` (`yield*` delegation unlanded), `yield-identifier-non-strict` and
  the class-element `v.value === 42` shapes (`next(v)` sent-value delivery,
  method-form producers). All previously scoped as **#2906 slice 3d-iii**.
- **native-resolve thenable assimilation** — 7 promise-then-all regs (bucket
  still net +11): `resolve-thenable`, `resolve-poisoned-then`,
  `resolve-settled-*-self` ("Cannot read properties of null (reading 'then')"),
  `rxn-handler-*` (one null deref inside `__drain_microtasks`). The native
  resolve path does not assimilate user thenables / self-resolution per
  §27.2.1.3.2. Does not block its bucket but is real spec noncompliance —
  should be filed as its own S/M issue.
- 1 async-function reg: `evaluation-body.js` ("Promise resolver null is not a
  function") — executor-shape gap, same thenable/capability family.

## 3. What activating COSTS (measured)

- **Correctness**: the 13+8 sampled regressions above. Extrapolated by bucket
  population (async-generator: −4/60 × 924 files ≈ −62; class-async: −2/60 ×
  2,730 ≈ −91, high variance): flipping **today** risks ~150 scored-lane
  regressions concentrated in async-gen/class shapes against ~180 gains
  elsewhere — net positive but a bad trade to bank when the blocking family is
  one identified slice from done.
- **Binary size** (standalone target, measured off→on):
  sync-only program **byte-identical** (36,240 → 36,240 — zero blast radius on
  non-async code); plainAsync 59.5→62.8 KB (+5.4%); multiAwait +0.6% (imports
  3→0); thenChain +9.4% (imports 9→3); **forAwait 59.3→40.2 KB (−32%, imports
  0)**; asyncGen: **compile_error (#680 gate) → 63.7 KB working host-free
  module**. Size is a non-issue.
- **Perf/complexity**: no new machinery — the flip PR is two predicates
  (rule 1). All complexity already landed carrier-gated + byte-inert.
- **Exposure**: the widen makes the native drive lane live on standalone,
  exposing latent native-lane bugs — #2978 (rejected-promise for-await
  infinite loop / OOM) is the known member of that class; its pairing
  constraint (#2934 3b) must be honored regardless of this decision, and its
  fix should precede or accompany the flip since the widen widens the paths
  into the native scheduler.

## 4. What activating UNLOCKS (de-duplicated, honest)

Corpus accounting from the merged standalone report @e348f55ca (12,091 official
rows carry a non-empty import set — the "~12k co-leaked rows"):

| family (unique official FILES)                                             | files | pass (leaky) | fail/CE | fail/CE that pass js-host |
| --------------------------------------------------------------------------- | ----- | ------------ | ------- | ------------------------- |
| `Promise_*` only                                                             | 4,412 | 1,882        | 2,530   | 834                       |
| **flag-gated** (`Promise_*` + `__create_async_generator` + `__make_callback`) | 6,364 | 2,869        | 3,495   | **1,372**                 |
| broad carrier (+ sync-gen `__gen_*`/`__create_generator` + `__get_caught_exception`) | 8,482 | 4,215        | 4,267   | 1,907                     |

- **Scored standalone lane** (currently 23,429/43,138 = **54.3%**):
  - *Immediate* (flip today, current substrate): sample-extrapolated ≈ **+30
    files net** (≈ +0.07pp) — for-await dstr (+~120 across its 1,234-file
    population) and Promise combinators (+~50) minus the async-gen/class
    regression mass (−~150). The mechanical rule exists precisely to not bank
    this mixed shape.
  - *After 3d-iii lands* (the activation condition): the negative mass
    disappears and the async-generator population (924 files) + class-async
    async-gen-method shapes flip from liability to upside. Honest medium-term
    ceiling for the whole flag-gated family is **+1,372 scored files ≈
    +3.2pp** (54.3% → ~57.5%) — reached incrementally as the remaining #2906
    3d-iii′/3c widenings and #2978-class native-lane bugs are fixed, with the
    flip as the prerequisite that makes each of those landings score at all.
  - The top gated cluster by category: `for-await-of` (864 Promise-leaking
    fails), class async methods (~534), Promise combinators (~335),
    async-generator (~118).
- **Host-free metric** (currently 18,913/43,138 = **43.8%**): direct
  conversion from the flag alone is SMALL — only **34** leaky passes have
  imports entirely within `Promise_*`/`__create_async_generator` (474 even
  counting `__make_callback` + `__get_caught_exception`), and the size probe
  confirms conversion is shape-dependent (top-level `.then` chains keep
  `Promise_then`/`__make_callback` declared via the #3035 dual-path bridge).
  The co-leaked `__get_caught_exception` (8,230 rows) and sync-gen `__gen_*`
  (6,706) are **not** gated by this flag and stay leaky until their own
  substrates land. The host-free mass converts only as the whole family
  retires — the widen is necessary, not sufficient.
- **Strategic**: #2895 (frame suspension), the rest of #2906, and #2865's
  async-gen headline all *require* the widened carrier to be observable on the
  scored lane. Every one of those XL slices is currently wasi-only — unscored.
  The flip is the single move that turns that whole in-flight program from
  byte-inert banking into scored conformance.

## 5. Recommendation

**Activate-with-conditions.** Specifically:

1. **Do not flip today** — rule 1 blocks on async-generator (−4) and
   class-async (−2), and that rule has been right twice (AG0, 07-02).
2. **Land #2906 slice 3d-iii** (async-gen `next(v)` sent-value delivery,
   rejected-yield step-promise routing, `yield*` delegation, method-form/
   class-element producers). This is the ONLY family blocking the mechanical
   criterion. It is already scoped in #2906's own decomposition and its owner
   lane is in-progress. Horizon: **M/L, one dev slice**.
3. **File the thenable-assimilation hardening** (native resolve must assimilate
   user thenables / poisoned then / self-resolution; ~7 sampled files) as its
   own S/M issue. Not flip-blocking (bucket net +11) but should ride before or
   soon after the flip.
4. **Honor the #2978 pairing constraint** (rejected-promise for-await loop +
   #2934 3b validity fix, one PR) before or with the flip — the widen widens
   the exposure of exactly that native-scheduler lane.
5. **Then re-run this A/B** (harness + commands recorded below; ~10 min wall)
   **including the class-async supplement as a sixth blocking bucket**, and on
   a passing rule-1 result flip `isStandalonePromiseActive` +
   `isStandaloneThenChainNativeActive` together in the tiny PR prescribed by
   the 07-03 decision — nothing else rides along; `merge_group` standalone
   report is the authoritative gate.

Total distance to a legitimate flip: **one M/L slice (3d-iii) + one S
re-measure/flip PR**, plus the already-mandated #2978 pairing. The prize
thereafter is not the mythical 12k, but it is real: ~+3pp scored standalone as
the family completes, zero regression debt, and the entire #2895/#2906 async
program finally scoring.

---

## Method / repro (verify-first appendix)

- Corpus artifact: `gh run download 29035099712 -R loopdive/js2 -n
  test262-merged-report` (merge_group @ `e348f55ca`, 2026-07-09). Unique-file /
  family / host-cross-lane accounting: python over
  `test262-standalone-results-merged.jsonl` + `test262-results-merged.jsonl`,
  `scope_official` only; family regexes as in §4's table.
- A/B: `.tmp` harness per the #2980 recipe (buckets: statements+expressions of
  async-function and async-generator, for-await-of, Promise
  then/all/race, await; deterministic every-k-th spread-sample; supplement:
  language/{expressions,statements}/class filtered `/async/`, n=60). Run:
  `npx tsx measure-carrier-ab.mts off` vs `JS2WASM_ASYNC_CARRIER_WIDEN=1 npx
  tsx measure-carrier-ab.mts on` (separate processes — the flag is a
  module-load const). Global uncaught/unhandledRejection guards required (host
  arm leaks floating rejections; 17 observed).
- Flag liveness: same file compiled off/on flips `wasm_sha`; gate reads
  verified at `src/codegen/async-scheduler.ts:3297-3348`.
- Size/import probe: `compile(src, { target: "standalone" })` over 6
  representative programs, off vs on, `r.binary.length` + `r.imports`.
