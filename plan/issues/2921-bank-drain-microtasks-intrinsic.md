---
id: 2921
title: "Bank the __drain_microtasks() carrier intrinsic (inert) extracted from the closed #2367 PR-B"
status: done
assignee: ttraenkler/senior-conflicts
created: 2026-07-02
completed: 2026-07-02
parent: 2867
related: [2867, 2918, 2864]
priority: medium
feasibility: medium
task_type: feature
area: codegen
goal: standalone
sprint: 69
horizon: s
---

# #2921 — Bank the `__drain_microtasks()` carrier intrinsic (inert)

## Problem

PR #2367 ("standalone native Promise carrier — funcIdx-shift + verdict drain",
#2867 PR-B) was **closed** because its central change — broadening
`isStandalonePromiseActive` to `ctx.standalone` — is a proven merged-baseline
regression (−1404) blocked on the native resumable-frame substrate (#2864, still
`in-progress`). See the close comment on PR #2367.

That PR also carried two pieces of **regression-free** infrastructure that are
inert without the gate-broaden and worth banking so they are ready when #2864
unblocks the carrier activation:

1. a **late-import funcIdx-shift fix** in the native `.then` receiver/callback
   buffers, and
2. the **`__drain_microtasks()` compiler intrinsic**.

On re-grounding against current `origin/main`, piece (1) **already landed** via
#2918 (`fctx.savedBodies.push/pop`, a cleaner mechanism than PR #2367's
`ctx.liveBodies.add(savedBody)`). The `target: wasi` repro that broke pre-#2918
("not enough arguments on the stack for call", the −601 invalid-Wasm) now
instantiates cleanly on main. So only piece (2) remained to bank.

## What this issue lands

The `__drain_microtasks()` intrinsic in `src/codegen/expressions/calls.ts`
(`compileCallExpression`). When the identifier `__drain_microtasks` is called
with zero args:

- if a native microtask queue is registered (`getDrainFuncIdxForWasiStart(ctx)`
  is non-null — i.e. some `.then`/Promise was lowered on a carrier target), emit
  a single `call` to the drain function;
- otherwise emit **nothing** and return `VOID_RESULT`.

The interceptor is guarded purely by the callee identifier, so any module that
does not literally write `__drain_microtasks()` is byte-identical to before — the
change is fully inert to gc/host/linear codegen and to Promise-free WASI modules.
It does **not** re-introduce the #2367 gate-broaden; `isStandalonePromiseActive`
is untouched (stays `ctx.wasi === true`).

This is the "runner `__drain_microtasks` hook" listed under
"Remaining for the unlock" in #2867. It gives a standalone/WASI embedder (and,
once #2864 unblocks activating the carrier for `--target standalone`, the
test262 harness verdict-read) a way to flush pending native `$Promise` reactions
before observing module state. The **harness-side** injection of this call (the
verdict-changing `tests/test262-runner.ts` edit from PR #2367) is deliberately
NOT banked here — it flips verdicts and belongs with the carrier activation, not
this inert infra bank.

## Test Results

`tests/issue-2921.test.ts` (all green):

- WASI carrier: a queued `.then` fulfil reaction (`ran = v`) does NOT run before
  `__drain_microtasks()` (returns 0), and DOES run after it (returns 5) — proves
  the intrinsic drives the drain, not eager `.then`.
- gc/host: `__drain_microtasks()` is a silent no-op (returns 7, no trap, no
  `__drain_microtasks` import leak).
- WASI with no registered queue: silent no-op (returns 7).

Typecheck clean. The intrinsic path is unreachable for any module not calling
`__drain_microtasks()`, so gc/host/linear/standalone output is byte-identical.

## Notes

This PR also carries `## Implementation Plan` architect specs for the two
block-`let`-capture issues whose regressing PRs were closed alongside #2367
(#2818, #2826) — they ride this PR rather than a doc-only push to main.
