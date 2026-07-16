---
id: 3227
title: "default (JS-host) lane: async-completion harness callbacks never execute → 1,690 vacuous fails (#2940 detector), dominated by for-await-of / dynamic-import / Promise"
status: in-progress
assignee: ttraenkler/fable-3
sprint: current
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: async, promises, for-await-of, dynamic-import, test262-harness
related: [3074, 3086, 3001, 2940, 2903, 2939, 1014, 1116, 1326c]
created: 2026-07-13
updated: 2026-07-16
origin: "2026-07-13 /harvest-errors. Baselines run 20260713-085257 (gitHash bb27494f, 32,990 pass), default lane test262-current.jsonl. Count unchanged from run 179d73ca."
---

# #3227 — default-lane async harness callbacks are vacuous (no assertion runs)

## Summary

The `#2940` vacuous-pass detector ("harness-wrapper callback never executed —
no assertion ran") fires **1,690 times in the DEFAULT (JS-host) lane**, making
it the single largest cited pattern in that lane's failing set. These were
previously *dishonest* passes (the test compiled + ran to completion but its
assertion-bearing callback never executed, so nothing was actually checked);
the detector now honestly reclassifies them to `fail`.

This is **distinct from #3074** (done 2026-07-08), which cleared the
*TypedArray* harness-wrapper vacuous cluster (`testWithTypedArrayConstructors`)
— that family is now gone from the top buckets. What remains, and what this
issue tracks, is the **async-completion** harness family (`.then` continuations
/ `$DONE` / for-await-of bodies). It is also distinct from the standalone
host-independence work in **#2903 / #2940** — that tracks removing the
`env::__make_callback` host *import* in `--target standalone`. Here the host import **is available**, yet
the async-completion callback still never runs. That points to a genuine
dropped-async-continuation correctness bug in the JS-host lane, not a
host-leak/representation problem. No existing issue tracks the default-lane
side of this.

## Distribution (top feature buckets, default lane, 1,690 total)

| Count | Feature area |
|-------|--------------|
| 383 | `language/statements/for-await-of` |
| 234 | `language/expressions/dynamic-import` |
| 168 | `annexB/language/eval-code` |
| 180 | `language/{statements,expressions}/class` (async methods) |
| 218 | `built-ins/Promise/{any,race,all,allSettled,prototype}` |
| 46  | `language/expressions/async-function`, `async-generator` |
| …   | remainder across Temporal ZonedDateTime/Instant async harness, direct eval |

Sample files:
- `language/expressions/dynamic-import/namespace/promise-then-ns-set-prototype-of.js`
- `language/expressions/async-function/nameless-dflt-params-ref-later.js`
- `language/expressions/async-generator/dstr/ary-ptrn-elem-id-iter-complete.js`
- `language/expressions/dynamic-import/catch/nested-async-function-eval-script-code-target.js`

## Root-cause hypothesis

test262 async tests wrap their assertions in a continuation that the harness
only invokes once a promise settles (the `$DONE` / `asyncTest` /
`.then(assertions)` pattern). The dominant buckets — `for-await-of`,
`dynamic-import` `.then` continuations, and the `Promise` combinators — all
depend on a microtask-scheduled callback firing. The callback body compiling
but never being *invoked* is the same failure family flagged in #2903's TL;DR
("host-backed builtin methods: Promise.then/.catch, Iterator helpers"), but
manifesting as a *dropped continuation* in the default lane rather than a host
leak. Likely candidates: the async continuation / microtask scheduling path
(`async-scheduler.ts`) not driving the queued `.then` callback for these
harness shapes, or the dynamic-dispatch arity/type tolerance from **#2939**
(marked done) covering only a subset.

## Acceptance criteria

- Pick one representative from each of the two largest buckets
  (`for-await-of`, `dynamic-import`) and confirm via a `.tmp/` repro that the
  assertion callback is genuinely never invoked (not merely asserting the
  wrong value).
- Identify why the continuation is dropped in the JS-host lane and fix so the
  callback runs; the vacuous detector count for these buckets drops
  materially.
- No regression to the standalone `__make_callback` front (#2903).

## Notes

- Detector mechanism: #2940 (done). Dynamic-dispatch arity/type fix: #2939
  (done) — clearly leaves a large residual here.
- Standalone counterpart of the vacuous flag is 779 records, tracked under
  #2903 (`ready`, host-independence). Keep the two fronts separate; a fix here
  targets the JS-host continuation path.
- **Not** covered by #3086 (honest-vacuity oracle scorer / rebaseline,
  in-progress) or #3001 (remove #2940 reclassification excusal, blocked) — those
  are detector/oracle *infrastructure*; #3227 is the underlying *feature* fix
  (make the async continuation actually run).

## Root cause — VERIFIED (2026-07-16, fable-3, slice 1)

The hypothesis ("dropped continuation") is WRONG in an interesting way — the
continuations are NOT dropped. Two verified mechanisms:

1. **Verdict read before host microtasks drain (the 1,690-record driver).**
   The runner calls `testFn()` synchronously (tests/test262-runner.ts,
   `runTest262File`) and reads the verdict from its return value. In the
   JS-host lane, `.then`/await continuations are scheduled on the HOST
   microtask queue, which structurally cannot drain while `test()` is still on
   the Wasm→JS stack. `__drain_microtasks()` is a deliberate no-op on this
   lane (#2895 PATH B). So the callbacks run — *immediately after `test()`
   returns* — but the verdict was already read: `__assert_count === 1` → -262
   → "vacuous". Empirically verified: `Promise.resolve(42).then(v => count =
   v)` shows count=0 sync, count=42 one macrotask later.

2. **`await <host promise>` yields NaN, synchronously (value corruption).**
   `const v = await Promise.resolve(7); count = v` sets count=NaN *before
   test() returns* — the continuation runs eagerly with a garbage value
   (externref→f64 read of the promise, not its settled value). `await 7`
   (non-promise) is fine. This is a separate compiler bug (slice 2) and is
   the root of most honest-fail flips below (`v.value` NaN, `done` wrong).

## Slice plan (dispatchable)

- **S1 (this PR, fable-3) — async post-drain verdict re-read + ORACLE_VERSION 4.**
  `wrapTest` exports `__result()` (same verdict logic as the `test()` epilogue)
  for async-flagged tests; `runTest262File` yields 2× `setImmediate` after a
  sync `1`/`-262` and re-reads. A deferred continuation THROW during the drain
  window is captured via temporary `uncaughtException`/`unhandledRejection`
  handlers and scored a fail for that test (pre-S1 it fired unattributed
  between tests and could kill the fork worker). Verdict-logic change ⇒
  ORACLE_VERSION bumped 3→4 (forward-monotonic auto-rebase in diff-test262).
  Measured on samples: 1,680 vacuous-callback records → ~25% flip to honest
  PASS (~420), ~62% to honest assert-fail (real signal, already scored fail
  today), ~8% stay vacuous; BUT ~25% of the 3,503 currently-passing
  async-flagged tests flip pass→honest-fail (~875, CI 525–1,225) because their
  post-await assertions finally run and hit real bugs. Net raw pass ≈ −455.
  Needs lead/PO sign-off (precedent: #3086 owner-approved honesty regression).
- **S2 — `await <host promise>` NaN corruption (JS-host lane).** Fix the await
  value read so the settled value is delivered (repro above; also the likely
  root of the `class-elements async-gen … v.value = 42` flip cluster). Expect
  this to recover a large share of the S1 pass→fail flips + convert many of
  the 1,680 into passes. Repro: `.tmp/repro-3227c.mts` shapes C1/C2/C4/C5.
- **S3 — async-generator `.next().then(...)` result delivery.** Flip cluster
  `yield-star-next-then-*` / `named-yield-*`: `done`/`value` read wrong in the
  `.then` continuation (assert #2 `done === false/true` fails). Distinct
  receiver: the IteratorResult object crossing the host boundary.
- **S4 — still-vacuous residual (~8%).** Callbacks that genuinely never run
  even post-drain (e.g. `Array.fromAsync` thenable chains, some
  dynamic-import namespace shapes). Diagnose per-family after S2/S3 land.

## S1 measured delta (sampled, for merge_group park-diagnosis)

| Population                                | n sampled | Flip                                    | Extrapolated |
| ----------------------------------------- | --------- | --------------------------------------- | ------------ |
| 1,680 vacuous-callback records            | 60        | → honest **pass**                        | **+~420**    |
| 1,680 vacuous-callback records            | 60        | → honest fail (already `fail` today)     | ~1,040 (no pass-count change; now carry real assert indices) |
| 1,680 vacuous-callback records            | 60        | stay vacuous (S4 residual)               | ~140         |
| 3,503 currently-passing async-flagged     | 80        | → honest **fail** (post-await asserts finally run) | **−~875** (CI 525–1,225) |

Net raw pass ≈ **−455** (intentional honesty regression, lead-approved
2026-07-16, precedent #3086). The −875 clusters are the S2/S3 work
definitions:

- **S2 cluster — await-NaN**: `class-elements async-gen … v.value === 42`
  fails (value is NaN); root = `await <host promise>` reads NaN synchronously.
- **S3 cluster — async-gen `.next().then(...)` IteratorResult**:
  `yield-star-next-then-*` / `named-yield-*` fail assert #2 (`done` wrong) —
  the IteratorResult crossing the host boundary delivers wrong `done`/`value`.

ORACLE_VERSION: S1 takes **v4**; draft PR #3111 (standalone host-backed
rejection) also drafted a 3→4 bump — whichever lands second must re-bump
(4→5) and add its own history entry. S1 assumes it lands FIRST.

## Test Results (slice 1)

- Issue-cited sample `async-generator/dstr/ary-ptrn-elem-id-iter-complete.js`:
  vacuous → **pass**. `dynamic-import/namespace/promise-then-ns-set-prototype-of.js`
  and `for-await-of/ticks-…`: vacuous → honest fail with real assert index.
- 60-record vacuous sample: 15 pass / 37 fail / 5 fail-vacuous / 3 skip.
- 80-record currently-passing async sample: 60 pass / 20 fail (all honest
  post-await assertion failures; clusters above).
- wrapTest consumer unit tests: issue-1049/1450/1385/1567/1318-locator — 24/24 pass.
