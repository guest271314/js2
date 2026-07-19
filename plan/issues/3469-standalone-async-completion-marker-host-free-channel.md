---
id: 3469
title: "Standalone async tests: originalHarness completion marker unobservable host-free (channel + drain gate)"
status: in-progress
sprint: current
priority: high
horizon: l
area: tooling
assignee: ttraenkler/senior-dev-async-sink
parents: [3417]
refs: [2860, 3178, 3428, 3436]
created: 2026-07-19
---

## Problem

On `--target standalone`, host-free async test262 tests can never signal
completion, so the runner's `Test262:AsyncTestComplete` poll times out and
~2,024 genuinely-async tests (`flags:[async]`) fail with
`other:async completion marker not observed`. Confirmed on 5 samples across
async sub-families in a host↔standalone parity investigation (Cluster A).

One shared root cause, **two parts**:

1. **CHANNEL** — test262 completion is `$DONE → print(...) → console.log("Test262:AsyncTestComplete")`.
   On `--target standalone`, `console.log`/`print` lowers to a **pure no-op**
   sink (#3436, `src/codegen/expressions/builtins.ts` — args evaluated for side
   effects then dropped; the `env.console_*` imports are deliberately NOT
   registered so #2961's host-import gate stays green). The marker goes nowhere.
   (WASI routes print to `fd_write`; standalone had no sink.)
2. **DRIVE** — standalone `.then`/await continuations land on the in-module
   WASM microtask ring. The originalHarness runner path never calls
   `__drain_microtasks()` (only the wrapped path did,
   `tests/test262-runner.ts:3349`). The export/intrinsic is real
   (`src/codegen/async-scheduler.ts:503`, exported via
   `exportDrainMicrotasksIfRegistered`).

Import-free ⇒ passes the #2961 gate, instantiates, runs clean — but nothing
observes completion.

## Fix (runtime + runner, dual-lane)

1. **RUNTIME (compiler):** give `--target standalone` a native host-free output
   sink for `console.log`/`print`. Accumulate each call's rendered arguments
   (via the existing `emitToString` value→native-string cascade) into an
   in-module `$AnyString` global (`__stdout_acc`), joined with spaces + a
   trailing newline. Expose readout exports `__stdout_prepare() -> i32` (flatten,
   return code-unit length) and `__stdout_char(i) -> i32`, mirroring the existing
   `__exn_render_prepare`/`__exn_render_char` pattern. Stays 100% host-free
   (WasmGC in-module) so the #2961 import-leak gate still rejects genuine leaks.
2. **RUNNER (worker + local runner):** in the originalHarness `asyncTest` path,
   for the standalone (host-free) target, call
   `instance.exports.__drain_microtasks()` after top-level `(start)` execution,
   then read the native sink for `Test262:AsyncTestComplete`/`…Failure` (feeding
   `harnessOutput`, in addition to the host `consoleProxy` the js-host lane uses).

## HONEST scope — signature-addressed (2,024) ≠ flips-to-PASS

The fix makes completion OBSERVABLE for 100% of the 2,024; each test then
resolves to pass / real-fail(re-bucket) / still-nothing(re-bucket). The
~445 async-fn/method/arrow + ~150 Promise-combinator tests are likeliest to
actually pass; the ~1,300 async-gen/for-await families depend on the #3178
async substrate and may re-bucket to honest FAILUREs. Primary value: un-blocking
the whole standalone async scoring effort. Flip-to-pass count measured
empirically on a representative subset (see Test Results), NOT claimed at 2,024.

## Implementation Notes (WHY)

- **Sink is standalone-only, not wasi.** WASI `console.log` already routes to
  `fd_write` (`compileConsoleCallWasi`); only the standalone arm was a no-op. The
  GC-string sink is gated on `ctx.standalone`.
- **Rope accumulator, flatten-on-read.** `__stdout_acc` holds an `$AnyString`
  rope (O(1) `__str_concat` append); `__stdout_prepare` flattens once into a
  `$FlatString` global that `__stdout_char` indexes — same shape as the exn
  render buffer, avoiding O(n²) readback.
- **Index-shift safety.** The append helper + acc global are minted lazily at the
  first standalone `console.log` call site; the append funcidx is re-read by name
  after each `emitToString` (which can insert a late import via
  `__extern_toString`), mirroring the WASI `writeStr` re-read discipline (#2642).
  Readout exports are emitted at finalize (append-only) like the exn exports.
