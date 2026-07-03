---
id: 2980
title: "Standalone async widen — FINAL layers (async-fn drive −16 residual, Gap 5 for-await/async-gen −32) + the slice-1d carrier-widen DECISION MEASURE"
status: ready
# measure phase delivered by ttraenkler/fable-5 (2026-07-02) — the four residual classes are the remaining work.
# NB the 07-02 claim release had NOT landed on the issue-assignments ref; force-released
# 2026-07-03 by the architect (`claim-issue.mjs --release 2980 ... --force`). Claimable now.
created: 2026-07-02
updated: 2026-07-03
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: codegen, runtime
language_feature: async
goal: standalone-mode
sprint: current
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
