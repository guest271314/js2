---
id: 2980
title: "Standalone async widen — FINAL layers (async-fn drive −16 residual, Gap 5 for-await/async-gen −32) + the slice-1d carrier-widen DECISION MEASURE"
status: done
completed: 2026-07-10
# measure phase delivered by ttraenkler/fable-5 (2026-07-02) — the four residual classes are the remaining work.
# NB the 07-02 claim release had NOT landed on the issue-assignments ref; force-released
# 2026-07-03 by the architect (`claim-issue.mjs --release 2980 ... --force`). Claimable now.
# 2026-07-05 (dev-2980): re-measured + landed class 1 as its own issue, #3035
# (self-contained PR). #2980 itself is STILL an umbrella over classes 2-4 +
# the full decision measure — released back to `ready` for the next dev to
# claim class 3 (independent, next-largest, −12) or pick up once #2906
# slices 3/4 land (classes 2+4). See "## Class 1 landed" below.
# 2026-07-10 (fable-2938): MEASUREMENT COMPLETE — all six buckets (incl. the
# class-async supplement) re-measured at main@d7a1feaa1c: total +20, no bucket
# ≤ −2 → rule 1 MET. The flip PR is NOT opened yet: gated on the #2978/#2833
# pairing (bot-park-held) + stakeholder sign-off. See the 07-10 section below.
# Claim released; the flip is an S slice once both gates clear.
created: 2026-07-02
updated: 2026-07-13
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: codegen, runtime
language_feature: async
goal: standalone-mode
sprint: 71
parent: 2895
depends_on: [2906, 2922]
related: [2867, 2919, 2865, 1373b]
origin: "#2922 residual re-scope (task #17) — arms 1-3 landed (PRs #2428/#2482); the remaining widen layers + the decision measure get their own id (#2922 is done on main)"
---

# #2980 — Async widen final layers + the carrier-widen decision measure

> **Provenance**: formerly #2971; re-id'd because id 2971 was taken on main by
> the TLA sibling-module evaluation-order issue (parallel session, #2531
> allocator race). The code-comment ref in src/codegen/async-scheduler.ts was
> renamed in the same commit.

## Problem

The slice-1d carrier widen (`isStandalonePromiseActive` +
`isStandaloneThenChainNativeActive` → include `--target standalone`) is the
step that unlocks the ~5,000 co-blocked sync-async standalone cluster. The
last full measure (pre-arms) was **net −145, dominated by the combinator
substrate (−97)** — which #2919/#2922 arms 1-3 (array-typed args,
not-iterable→reject, generic iterables; PRs #2428/#2482) have since addressed.
Remaining per the #2867 gap ledger before the widen can flip:

1. **async-fn drive residual (the −16 signature)** — the async-function
   74-file corpus regression measured under the broad widen; caused by the
   carrier gaps, most of which have landed since (Gaps 1-4, #2906 slices 1-2,
   #2483 host-drive). Needs RE-MEASUREMENT, not assumed work.
2. **Gap 5 (−32): for-await-of / async-generator drive** — #2906 slices 3
   (loop back-edges + async-iterator protocol) and 4 (the `$Frame`/`$AsyncFrame`
   AG2 convergence). Real new code, carrier-gated + banked byte-inert.
3. **THE DECISION MEASURE** — full async-corpus A/B (carrier gate on vs off,
   `--target standalone`). The gate flips ONLY on a measured positive net, as
   its own tiny PR. A negative measure with a residual breakdown is a SUCCESS
   outcome (bank the layers, file the residuals).

## Measurement instrument (this issue, landed inert)

`JS2WASM_ASYNC_CARRIER_WIDEN=1` env toggle in `src/codegen/async-scheduler.ts`
widens BOTH carrier gates together for a measurement process without
committing the flip (unset ⇒ exactly `ctx.wasi === true`, all lanes
unchanged — CI never sets it). A/B harness: `.tmp/measure-carrier-ab.mts`
(corpus sampled BY CONSTRUCT: async-function, for-await-of, async-generator,
Promise then/all/race, await-expr; deterministic spread-sample per bucket)

- `.tmp/measure-carrier-diff.mts` (per-bucket net + regression listing),
  running `runTest262File(..., "standalone")` with the #2404 drain hook.

## Acceptance criteria

- A/B measure recorded in this file (per-bucket off-pass/on-pass/net + the
  regression breakdown), on current main including arms 1-3.
- Gap-5 layers landed carrier-gated + byte-inert (sha256 proof) IF the
  measure shows for-await/async-gen as the blocking residual.
- The widen decision: flip PR opened ONLY on measured positive net; otherwise
  residual issues filed per class and the layers banked.

## Discipline

Async graveyard rules: carrier-gated, banked inert, corpus-verified by
construct, escalate rather than churn. gc/host + still-host-backed standalone
lanes stay byte-identical for every banked layer (the −16/−29 guard's
requirement); the env toggle itself is dead code in CI.

## DECISION MEASURE — 2026-07-02 (fable-5, main @461da1576 incl. arms 1-3 + #2483)

Per-construct A/B, `--target standalone`, 262 sampled files (deterministic
spread-sample), carrier gates off vs on (`JS2WASM_ASYNC_CARRIER_WIDEN`):

| bucket           | n   | off-pass | on-pass | net     | +fixed/−regressed |
| ---------------- | --- | -------- | ------- | ------- | ----------------- |
| async-function   | 60  | 48       | 36      | −12     | +5 / −17          |
| for-await-of     | 60  | 37       | 22      | −15     | +0 / −15          |
| async-generator  | 60  | 47       | 41      | −6      | +0 / −6           |
| promise-then-all | 60  | 41       | 23      | −18     | +0 / −18          |
| await-expr       | 22  | 10       | 10      | 0       | +1 / −1           |
| **TOTAL**        | 262 |          |         | **−51** | +6 / −57          |

**VERDICT: the gate does NOT flip.** The combinator-substrate share of the old
−145 is indeed gone (arms 1-3 worked), but the residual decomposes into FOUR
distinct classes, each needing its own layer before a re-measure:

1. **native `.then` receiver casts (−18, promise-then-all)** — dominated by
   `ref.cast failed to cast reference to target heap type` in `.then` chains
   under the widened `isStandaloneThenChainNativeActive`: a `.then` receiver
   that is not a native `$Promise` (constructor-executor promises —
   "Promise constructor takes a function argument" also appears —,
   `Promise.prototype.then.call` shapes, capability objects) hits the
   unconditional native cast. The −601-class hazard, narrowed but real.
2. **Gap 5 for-await drive (−15, for-await-of)** — all semantic fails
   (`returned 2` assert mismatches) in async-from-sync-iterator / dstr
   shapes: the for-await loop cannot drive natively-carried promises
   (#2906 slice 3 — loop back-edges + async-iterator protocol).
3. **async-fn abrupt/override shapes (−12, async-function)** — try/finally
   with abrupt override (`try-{reject,return,throw}-finally-{throw,return}` —
   `planLinearAwaits`-rejected, fall to legacy which mishandles native
   carriers), default-param abrupt rejection routing, arguments-access
   (`returns-async-{arrow,function}-returns-arguments` null deref).
4. **async-generator yield/rejection routing (−6)** — awaited-thenable as
   yield operand + `yield`-promise-reject-next `done` handling (#2906
   slice 4 territory).

Raw data: `.tmp/ab-{off,on}.jsonl` (regenerable via
`.tmp/measure-carrier-ab.mts` at any commit). The +6 fixed are
forbidden-ext caller-access shapes (incidental).

**Banked by this issue:** the measurement instrument (env-toggled widen —
inert, CI never sets it) + this recorded measure. **Filed forward:** the four
residual classes above must land (each carrier-gated + byte-inert) before the
next decision measure; classes 2+4 are #2906 slices 3/4, class 1 is a
`.then`-receiver-classification hardening in `async-scheduler.ts`
(`emitStandalonePromiseThen` must fall back on a non-`$Promise` receiver
instead of casting), class 3 is `planLinearAwaits` Gap-3 widening
(finally-override + return-through-finally) plus default-param abrupt
routing.

---

## Architect Decision — slice-1d carrier widen (2026-07-03, fable)

**RATIFIED: the widen gate does NOT flip now.** The 2026-07-02 decision
measure above (main@461da1576, post arms 1-3 + #2483; net **−51** over the
262-file construct-sampled corpus) is accepted as the deciding evidence.
Post-measure drift check (2026-07-03): **two class-1-adjacent PRs have since
landed on main** — #2959 (native `new Promise(executor)`, retiring the
`Promise_new` host import) and #2671 slice 2 (Promise capability statics,
+28 test262) — both touch exactly the constructor-executor / capability
shapes that dominate the −18 promise-then-all bucket. They plausibly shrink
class 1 but cannot flip the total (classes 2-4, −33 combined, are unlanded),
so the verdict stands without a full re-run; instead they move the interim
re-measure of rule 5 EARLIER (see below). Standing rules until the flip:

1. **Flip criterion (mechanical, no judgment call needed at flip time):**
   re-run `.tmp/measure-carrier-ab.mts` after residual classes land; the
   gate flips only on a measured **positive total net with no construct
   bucket net-negative beyond noise (net ≤ −2 in any bucket blocks)**. The
   flip is its own tiny PR: the two gate predicates
   (`isStandalonePromiseActive`, `isStandaloneThenChainNativeActive`) plus
   the recorded measure — nothing else rides along.
2. **No partial / per-construct widening.** Flipping only the near-neutral
   buckets (e.g. await-expr at net 0) is DECLINED: the two gates widen
   together by design, and per-construct gating forks the carrier matrix
   (every subsequent layer would need N gate combinations validated). One
   gate, one flip, one measure.
3. **Residual sequencing (by measured weight, largest first):**
   - **Class 1 (−18)** `.then`-receiver classification hardening in
     `async-scheduler.ts` — `emitStandalonePromiseThen` must fall back
     (host/dynamic path) on a non-`$Promise` receiver instead of the
     unconditional `ref.cast`. Independent of #2906; claimable on its own;
     the single largest win.
   - **Class 3 (−12)** `planLinearAwaits` Gap-3 widening (finally-override +
     return-through-finally) + default-param abrupt rejection routing.
     Independent of #2906.
   - **Classes 2 (−15) + 4 (−6)** are **#2906 slices 3/4 by that issue's own
     decomposition** — for-await drive (loop back-edges + async-iterator
     protocol) and the async-gen yield/rejection routing. This decision
     assigns no new direction to #2906; it is consistent with #2906's
     in-progress multi-state CFG resume-machine work by construction, since
     every layer lands carrier-gated + byte-inert (sha256 proof), so #2906's
     landings cannot regress un-widened lanes and the next measure is purely
     additive evidence.
4. **Instrument is the contract.** `JS2WASM_ASYNC_CARRIER_WIDEN=1` remains
   the ONLY widen mechanism until the flip PR; CI never sets it; no layer
   may condition on anything else. Re-measures cite the main SHA they ran
   at, appended to this file.
5. **Re-measure cadence:** BEFORE writing class-1 code, regenerate the A/B
   harness (the dead agent's `.tmp/measure-carrier-ab.mts` did not survive —
   rebuild per the "Measurement instrument" section: construct-bucketed
   spread-sample, `runTest262File(..., "standalone")` + #2404 drain hook,
   `JS2WASM_ASYNC_CARRIER_WIDEN=1` for the on-arm) and re-run the
   **promise-then-all bucket only** (~120 runs, cheap): #2959 + #2671-s2
   may already have partially delivered the class-1 win, and the residual
   listing tells the class-1 dev which receiver shapes are still hitting
   the unconditional cast. Then after class 1 lands, an interim full A/B;
   the flip decision waits for classes 2-4 or an explicitly-accepted
   partial residual (a bucket may be accepted as a filed-forward
   known-negative ONLY if the total net is positive per rule 1).

Housekeeping: the stale in-progress claim from the dead 07-02 agent
(`ttraenkler/agent-ab81b787ac6992334`) was force-released 2026-07-03; the
issue is claimable.

## Class 1 landed — 2026-07-05 (dev-2980, main@13350e8f9)

Per rule 5: rebuilt the A/B harness (`.tmp/measure-carrier-ab.mts` — the dead
agent's copy did not survive `.tmp/` being gitignored) and re-ran the
**promise-then-all bucket only** (60-file deterministic spread-sample) BEFORE
writing class-1 code:

| arm                        | pass/60 | regressed vs off |
| -------------------------- | ------- | ---------------- |
| off (baseline)             | 37      | —                |
| on (widen), before class 1 | 21      | 16               |
| on (widen), after class 1  | 33      | **4**            |

**#2959 + #2671 slice 2 had NOT meaningfully shrunk class 1** in this fresh
measurement (16 regressed — matching the original −18 order of magnitude,
not the "plausibly shrink" the 07-03 architect note hoped for). Class 1
itself — `emitStandalonePromiseThen`'s unconditional `ref.cast` on a
non-native-`$Promise` `.then`/`.catch` receiver (deferred combinators
`allSettled`/`any`, constructor-executor / capability-object shapes) — is now
fixed: a runtime `ref.test` routes non-native receivers to the pre-existing
host `.then` path instead of trapping. Landed as **#3035** (self-contained,
independent per this file's rule 3, banked inert — `main`'s unwidened /
un-WASI behaviour is unchanged; the WASI lane, where native chaining is
unconditional, gets the same hardening as a real observable fix).

Full detail + the 4 residual (out-of-scope, different-root-cause)
regressions: see #3035.

**#2980 itself stays open** — classes 2 (−15, #2906 slice 3), 3 (−12,
`planLinearAwaits` Gap-3 + default-param abrupt routing — unclaimed,
independent, next-largest), and 4 (−6, #2906 slice 4) are unlanded, so the
full decision-measure re-run and the flip PR both remain blocked per rule 1.
The interim full A/B (rule 5, after class 1) is deferred to whoever lands
class 3 or the #2906 slices next — re-running all 5 buckets now would only
re-confirm the unchanged classes-2/3/4 residual at extra cost without new
information.

## FULL A/B RE-MEASURE — 2026-07-09 (fable-3100s4, main@0551d83)

Per rule 5, ran the full 262-file construct-bucketed A/B on **current main**
(after 3a/3b/3d-i/3d-ii + #3035 all landed since the 07-02 measure). The
harness (corpus selector + per-arm runner + diff) is now **durably committed**
under `scripts/measure/` (rule-5 fix — the prior `.tmp/` copy did not survive).

**Baseline re-measure (before this issue's fallback layer):**

| bucket           | n   | off | on  | net     |
| ---------------- | --- | --- | --- | ------- |
| async-function   | 60  | 32  | 35  | +3      |
| for-await-of     | 60  | 14  | 20  | +6      |
| async-generator  | 60  | 42  | 38  | **−4**  |
| promise-then-all | 60  | 6   | 16  | +10     |
| await-expr       | 22  | 9   | 10  | +1      |
| **TOTAL**        | 262 | 103 | 119 | **+16** |

The picture **transformed** since 07-02 (was −51 total): classes 1/2/3 all
resolved (promise-then-all −18→+10 via #3035; for-await −15→+6 via 3a/3b;
async-fn −12→+3). **`async-generator` (−4) is the SOLE flip-blocker.**

**Root-cause of the −4 (per-file drill, NOT the async-gen drive).** All 5
regressions are LEGACY-path async gens (function-expression / `yield*` — the
3d-i named-decl drive never touches them; they leak `__gen_next`/
`__gen_yield_star` in BOTH arms). File 1 import diff off→on shows
`Promise.reject`/`resolve` + `__get_caught_exception` go NATIVE under the
widen while `.then`/`.catch` STAY host and `__gen_next` stays legacy: the −4
is the **native-`$Promise`-construction × host-`.then`/`.catch`-chain ×
legacy-async-gen** interaction (the #2980 class-1 `.then`-receiver / #2978
lane), NOT #2906 3d-iii. (arch-2980 §2 AND the bucket-level number both
mis-attributed it to the async-gen drive; only the per-file drill found it.)

### Conservative-fallback layer landed — 2026-07-09 (fable-3100s4)

**A module containing ANY async generator keeps BOTH carrier gates OFF on the
widened-standalone lane** (`isStandalonePromiseActive` +
`isStandaloneThenChainNativeActive` → `ctx.standalone && !ctx.moduleHasAsyncGen`),
so its whole promise pipeline stays host-consistent (native `$Promise` never
feeds the legacy `__gen_*` buffer / host `.then`). `moduleHasAsyncGen` is set
in the pre-body `collectDeclarations` walk (so a `Promise.reject` INSIDE the
gen also sees it). NOTE: a construction-site-only fallback (Promise.resolve/
reject → host) is INSUFFICIENT — the widen also flips `await`-unwrap +
`__get_caught_exception` native, which break against the legacy async-gen too;
the module-level predicate gate keeps the WHOLE lane host.

**Re-measure WITH the fallback (same corpus, on-arm = widen+fallback):**

| bucket           | n   | off | on  | net     |
| ---------------- | --- | --- | --- | ------- |
| async-function   | 60  | 32  | 35  | +3      |
| for-await-of     | 60  | 14  | 18  | +4      |
| async-generator  | 60  | 42  | 42  | **+0**  |
| promise-then-all | 60  | 6   | 16  | +10     |
| await-expr       | 22  | 9   | 10  | +1      |
| **TOTAL**        | 262 | 103 | 121 | **+18** |

**FLIP-BLOCKERS: NONE. VERDICT: FLIP** (rule 1: positive total AND no bucket
net ≤ −2). async-gen −4→+0 (all 5 regressions verified PASS); total IMPROVED
+16→+18. Only cost: for-await +6→+4 (2 for-await files with async gens lose a
native-promise win by falling back to host — still PASS, ZERO regressions).
In-bucket residual negatives (async-function −1 `evaluation-body`,
promise-then-all −3 capability/race) are PRE-EXISTING (unchanged by the
fallback) and don't block (net-positive buckets).

The fallback is **BANKED INERT**: gated inside the `ASYNC_CARRIER_WIDEN_MEASURE`
branch, so un-measured gc/host/wasi/normal-standalone are byte-identical
(`moduleHasAsyncGen` is set in collect but only READ under the measure — proven:
21/21 program×lane sha256 identical to base). It makes the widen FLIPPABLE; the
actual two-predicate flip is still its own tiny PR (rule 1), which per §3 must
ride with/after the #2978 #2934-3b validity pairing AND (scoreboard-affecting)
needs explicit stakeholder sign-off before merge.

**Still filed forward:** #3120 — #2906 3d-iii implicit-yield-await (§27.6.3.8:
plain `yield <promise>` must Await; currently yields NaN) — a real host-free
async-gen conformance win, ORTHOGONAL to the flip (the −4 files are legacy, not
driven), banked separately.

## CONFIRMATION RE-MEASURE incl. the class-async SIXTH bucket — 2026-07-10 (fable-2938, main@d7a1feaa1c)

The 07-09 record above declared VERDICT: FLIP but its table omits the
**class-async supplement**, which `plan/log/2980-carrier-widen-tradeoff.md` §6
point 5 makes an explicit **sixth blocking bucket** (it was −2 at the 07-09
tradeoff measure — a rule-1 blocker on its own). This run re-measures ALL SIX
buckets fresh at main@`d7a1feaa1c` (post #3120/#3125/#3121 and the
conservative-fallback layer `b66d7e2ceb`, all landed):

| bucket               | n   | off | on  | net     | +fixed/−regressed |
| -------------------- | --- | --- | --- | ------- | ----------------- |
| async-function       | 60  | 32  | 35  | +3      | +4 / −1           |
| for-await-of         | 60  | 14  | 18  | +4      | +4 / −0           |
| async-generator      | 60  | 43  | 43  | +0      | +0 / −0           |
| promise-then-all     | 60  | 18  | 30  | +12     | +18 / −6          |
| await-expr           | 22  | 9   | 10  | +1      | +1 / −0           |
| class-async (suppl.) | 60  | 46  | 46  | **+0**  | +3 / −3           |
| **TOTAL**            | 322 |     |     | **+20** | +30 / −10         |

**Rule 1 across all six buckets: MET** — positive total (+20), no bucket
≤ −2 (worst is 0). The class-async supplement's 07-09 blocker (−2,
`yield-promise-reject-next*`) is cleared by the conservative fallback: its 3
residual regressions are now `illegal cast in __then_fulfill_0` /
static-async-method shapes (filed-forward known-negatives inside a net-0
bucket — non-blocking per rule 1). Also non-blocking, filed forward:
promise-then-all's 6 in-bucket regs (thenable-assimilation edges —
`resolve-thenable`, `resolve-poisoned-then`, `rxn-handler-*` — the #3125
class, partially landed) and async-function's `evaluation-body.js`
(pre-existing).

Harness: the `scripts/measure/` recipe. This PR banks the missing piece into
`scripts/measure/corpus.mjs`: the `class-async` bucket
(`language/{expressions,statements}/class` filtered `/async/`, cap 60, per
the tradeoff-doc appendix) plus a `MEASURE_BUCKET` env filter for cheap
single-bucket re-runs. (Run guards for escaping wasm traps were already in
`arm.mts`; one off-arm async-function file does crash an unguarded runner
via an escaping null-deref rejection, so keep the guards.)

### Flip status after this measure

The measurement precondition is FULLY met. The flip PR (the two predicates
`isStandalonePromiseActive` + `isStandaloneThenChainNativeActive`, nothing
else) remains gated on the two NON-measurement conditions of the 07-09
record:

1. **#2978/#2934-3b pairing (PR #2833)** — the tradeoff doc §6 point 4 says
   the pairing lands "before or with the flip". PR #2833 is currently
   **bot-park-held** (`auto-park-bot:merge-group-failure`, 3 park cycles on
   2026-07-10) — a real merged-state regression owned by that PR's author;
   the flip waits for it.
2. **Explicit stakeholder sign-off** (scoreboard-affecting change, per the
   07-09 record).

Escalated to the tech lead with this measure; #2980 claim released — the
flip PR is an S slice for whoever holds the pen when #2833 lands + sign-off
arrives.

## ✅ THE FLIP — 2026-07-10 (fable-2938, stakeholder sign-off granted)

Both non-measurement gates cleared on 2026-07-10: **PR #2833** (the
#2978/#2934-3b pairing) merged at 15:16, and **explicit stakeholder
sign-off** was granted (relayed by the tech lead). Per rule 1, the flip PR
carries exactly the two predicates + this record:

- `isStandalonePromiseActive` / `isStandaloneThenChainNativeActive` →
  `ctx.wasi === true || (ctx.standalone === true && !widenAsyncGenFallback(ctx))`
  — verbatim the MEASURED on-arm semantics (the conservative async-gen
  fallback `b66d7e2ceb` included). The `JS2WASM_ASYNC_CARRIER_WIDEN`
  instrument is retired (on-arm == production now); the harness stays in
  `scripts/measure/` for future re-measures.
- The former #2865 receiver-directed arm of the then-chain predicate
  (`getDrainFuncIdxForWasiStart(ctx) !== null`) is subsumed: the widened arm
  is a superset for every non-async-gen standalone module, and async-gen
  modules measured host-clean (bucket net 0, zero regressions) with the
  whole lane host per the fallback.
- One consequential test update: `tests/issue-2978-forawait-rejected.test.ts`
  "standalone carrier-off" case — post-flip that lane is carrier-ON, so the
  rejected-promise for-await now delivers the ORIGINAL rejection reason
  (spec-correct, identical to its wasi case) instead of the bounded-cap
  TypeError. Expectation updated with provenance comment.
- Production-behavior probe (no env): plain async module compiles host-free
  (no `Promise_resolve` import); async-gen module keeps the host lane
  (`Promise_reject` import present) — exactly the measured arms.
- Local validation: issue-2978/2979/2980-carrier-fallback suites green;
  tsc/prettier clean. NB `tests/issue-2865-standalone-async-await-unwrap.test.ts`
  has 2 WASI-lane failures locally that reproduce IDENTICALLY on unmodified
  main (pre-existing local-env artifact; wasi arm untouched by this flip;
  green in CI on main) — not a flip effect.
- The authoritative gate is the `merge_group` standalone lane (48k) — this
  PR is scoreboard-affecting (~+20 construct-sampled; population estimate
  per the tradeoff doc §4). `auto-park` catches any residual.

**#2980 is DONE with this flip.** The #2867/#2895/#2906 async program now
scores on the standalone lane. Filed-forward known-negatives (inside
net-positive buckets): thenable-assimilation edges (#3125 class, 6 sampled
files), `evaluation-body.js`, the 3 class-async static-async illegal-cast
shapes. Follow-ups belong to their own issues.
