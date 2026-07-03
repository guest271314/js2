---
id: 2918
title: "Standalone async widen prerequisite: native Promise.then/.all funcIdx-shift desync (the −601 invalid-Wasm)"
status: done
assignee: ttraenkler/sendev-promisethen
created: 2026-07-01
completed: 2026-07-01
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
sprint: 69
horizon: l
related: [2867, 2895, 2906, 2860]
umbrella: 2860
---

# Native Promise.then / Promise.all funcIdx-shift desync (the −601 invalid-Wasm)

## Problem

The native `.then` chaining (`emitStandalonePromiseThen`) + the `Promise.all`/`race`
combinators (`promise-combinators.ts`), carrier-gated on
`isStandaloneThenChainNativeActive` (wasi-only today), produce **invalid Wasm** at
standalone corpus scale — the "−601" regression documented at
`async-scheduler.ts:3309` and caught only in the `merge_group`:

```
Promise.all(<x>).then(fn, fn).then($DONE, $DONE)
  → WebAssembly.compile(): function "test" failed:
    not enough arguments on the stack for call (need 4, got 0)
```

This is the **#1 blocker of the standalone async count-move**: a widen that emits
invalid Wasm cannot merge at all (a hard gate failure, not a metric regression),
so the invalid-Wasm class had to be cleared before any of the ~5,000 co-blocked
async cluster could be measured.

## Root cause (two coupled late-import funcIdx-shift holes)

Reproduced by flipping the carrier to `standalone` on a throwaway measurement
branch and compiling the `built-ins/Promise/{all,race,then}` corpus. Minimal
repro: `var o = {}; Promise.all(o).then((v)=>v,(e)=>{})` — a local **object
literal** (any late-import-adding construct) preceding a native `.then` whose
receiver is a host-path `Promise.all`.

The emitted `{}` lowering baked `call 71` (`__new_plain_object`) into `test.body`.
A late import then landed while the native-then path was compiling, shifting every
defined function up by 1 — `__new_plain_object` moved 71→72 (a 0-param helper),
but the already-emitted `call 71` in `test.body` was **not** repointed, so it now
targeted `__key_equals` (a **4-param** helper) → "need 4, got 0".

Two independent reasons the shift missed the stale index:

1. **Incomplete side-channel shift lockstep.** Three separate shifters
   (`shiftLateImportIndices`, `addStringImports`, `addUnionImports`) each carried
   a *different, partial* list of the async-substrate side-channel funcIdxs.
   `shiftLateImportIndices` omitted `promiseResolveValueFuncIdx` (#2867 Gap 1, the
   `.then` handler-wrapper settle target) **and every `Promise.all`/`race`
   combinator idx**; the other two omitted the async keys entirely. A late import
   between the settle-helper registration and a downstream bake left those indices
   stale-low.

2. **Buffer-swap `savedBodies` reachability hole.**
   `compilePromiseThenReceiverBuffer` / `compileStandalonePromiseThenCallback`
   swapped `fctx.body` to a scratch buffer but stashed the real body in a **bare
   local**, invisible to the shifter's `fctx.savedBodies` walk. So a late import
   fired mid-buffer shifted the buffer + `funcMap` + `liveBodies` but NOT the
   `call`/`ref.func` already emitted in the outer function body.

## Fix

- **`async-scheduler.ts`**: new `shiftAsyncSideChannelFuncIdxs(ctx, importsBefore,
  added)` — the single source of truth, shifting the COMPLETE async-scheduler key
  list (now including `promiseResolveValueFuncIdx`) **and** the combinator keys
  (`ctx.__promiseCombinators`). Called from ALL THREE shifters so the indices can
  never drift out of lockstep depending on which import path fired.
- **`expressions/calls.ts`**: both promise-then buffer helpers now push the real
  body onto `fctx.savedBodies` (and pop in `finally`) during the swap, so a
  mid-buffer late-import shift walks it.

**Carrier-gated inert (byte-proven).** The shift keys are all `-1` off-carrier
(the async substrate never emitted) and the buffer helpers are only reached under
`isStandaloneThenChainNativeActive` (wasi-only). sha256 of `gc` + `standalone`
binaries for 4 representative programs (plain / object-literal-then-chain /
async-fn-then / string-concat) are **identical** clean-upstream-vs-fix. The
carrier gate is **NOT widened** here — that stays for the later net-positive
measure once the residual (below) + Gap 5 land.

## Measured effect (carrier flipped to standalone, corpus of 314 files)

| lane                         | pass | fail | compile_error |
| ---------------------------- | ---- | ---- | ------------- |
| host baseline (upstream/main)| 221  | 55   | 38            |
| widen, no fix                | 117  | 145  | 52            |
| widen + this fix             | 117  | 159  | **38**        |

The fix **eliminates the invalid-Wasm class** — `compile_error` returns to the
host baseline (52→38; `Promise/all` ce17→11, `Promise/race` ce17→9). The −601
"not enough arguments" hard merge-blocker is gone; the widen now emits valid Wasm.
Pass count is unchanged because the *remaining* widen regressions are a **separate
correctness layer**, not the stack bug (see Residual).

## Residual (escalated — architectural, do NOT churn)

The remaining widen regressions are dominated by **65 "illegal cast"** — the
native `.then` does an unconditional `ref.cast $Promise` on its receiver, which
traps when the receiver is a **host-path promise** (`Promise.all(<generic
iterable>)` / `race` on a non-array-literal, subclass capability ctors, or a
synchronously-compiled async fn). These need **native generic-iterable
`Promise.all`/`race`** (the #2867 Gap 4 "generic iterable" deferred scope) so
there are no host-path promise receivers — an architectural fork, not a bounded
fix. The async-fn drive residual (−16 stmt / −6 expr on this corpus) is the
#2906 drive-layer observability, untouched by this funcIdx fix.

Also found (out of scope, separate pre-existing wasi-lane bug, same desync class
in the closure-capture path): `let m = new Map(); m.set("a",1);
Promise.resolve(1).then((v)=>m.get("a"),...)` emits invalid Wasm in `__closure_0`
under `--target wasi` on clean upstream/main — a Map-helper late-import shift
desyncing a captured-closure body. Follow-up.

## Test

`tests/issue-2918-promise-then-funcidx-shift.test.ts`: a unit test pinning the
shift-key completeness (fails if `promiseResolveValueFuncIdx` or a combinator key
is dropped) + two wasi carrier compiles asserting the object-literal-before-then
shapes stay valid + host-free. Existing carrier suites (`issue-2867`, `-gap2`,
`-gap4`, `issue-2895-async-frame`, `-drain-hook`, `async-await`) stay green; the 2
`promise-combinators.test.ts` failures are the pre-existing gc/host `Promise.race`
runtime-shim (`src/runtime.ts`), on the byte-identical lane — not this change.
