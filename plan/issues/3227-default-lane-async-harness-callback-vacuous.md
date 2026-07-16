---
id: 3227
title: "default (JS-host) lane: async-completion harness callbacks never execute → 1,690 vacuous fails (#2940 detector), dominated by for-await-of / dynamic-import / Promise"
horizon: xl
status: ready
sprint: current
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: async, promises, for-await-of, dynamic-import, test262-harness
related: [3074, 3086, 3001, 2940, 2903, 2939, 1014, 1116, 1326c]
created: 2026-07-13
updated: 2026-07-13
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
