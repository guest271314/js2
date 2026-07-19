---
id: 3469
title: "Standalone async tests: originalHarness completion marker unobservable host-free (channel + drain gate)"
status: done
sprint: 72
priority: high
horizon: l
area: tooling
assignee: ttraenkler/senior-dev-async-sink
parents: [3417]
refs: [2860, 3178, 3428, 3436]
created: 2026-07-19
completed: 2026-07-19
# (#3102) LOC-regrowth allowance — the host-free stdout sink lives in the
# cohesive native-strings subsystem next to __exn_render_* (its natural home),
# with small wirings in the console call site, finalize pipeline, ctx type, and
# import collector. No new god-file/barrel growth beyond these adds.
loc-budget-allow:
  - src/codegen/native-strings.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/import-collector.ts
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
   sink for `console.log`/`print`. Each argument is rendered to a native
   `$AnyString` via `__any_to_string` (the import-free stringifier the exn-render
   path uses; `externref` args are `any.convert_extern`'d first), then appended to
   an in-module `$AnyString` accumulator global (`__stdout_acc`), joined with
   spaces + a trailing newline. Dispatch is on the compiled **ValType** (a
   wasm-lowering question), NOT the TS static type — the latter trips the
   oracle-ratchet gate and is wrong here (see the `any`-param note below). Expose
   readout exports `__stdout_prepare() -> i32` (flatten, return code-unit length)
   and `__stdout_char(i) -> i32`, mirroring `__exn_render_prepare`/
   `__exn_render_char`. Stays 100% host-free (WasmGC in-module) so the #2961
   import-leak gate still rejects genuine leaks. Bare scalar args (a number/bool
   passed directly, `f64`/`i32`) are dropped best-effort — never a marker.
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
- **Index-shift safety.** The append helper + acc global are minted in the
  pre-body window (gated on `ctx.usesStandaloneConsoleSink`), so `__stdout_append`'s
  funcidx is final for every call site that bakes it; the funcidx is still re-read
  by name at each emission point (`compileExpression`/`ensureAnyToStringHelper` can
  insert a late import that shifts indices, #2642). Readout exports are emitted at
  finalize (append-only) like the exn exports.
- **The `any`-typed param chain was the load-bearing subtlety.** The marker does
  NOT reach `console.log` as a string literal — it flows through `any`-typed
  harness params (`$DONE → __consolePrintHandle__(msg) → print(value) →
  console.log(value)`), so at the call site the arg is statically `any`, compiled
  to an `externref`. A static-type gate that only rendered `string` args dropped
  it. Fix: dispatch on the compiled ValType and render every non-scalar via
  `__any_to_string` (`externref` → `any.convert_extern` first; `ref`/`ref_null`
  native-string/struct are `anyref` subtypes rendered directly) — never
  `emitToString`'s externref arm, which would register the `__extern_toString`
  host import and trip #2961.
- **ValType dispatch, not `ctx.checker` (oracle-ratchet).** Using
  `ctx.checker.getTypeAtLocation(arg)` here would trip the #1930/#3273
  oracle-ratchet gate (`quality`). It is also unnecessary: what we need is a
  wasm-lowering question ("is the compiled value an externref, a GC ref, or a
  scalar?"), answerable from the ValType alone — which is deliberately ABOVE what
  `ctx.oracle` expresses. Net checker growth is 0.

## Test Results

Focused unit test: `tests/issue-3469-standalone-async-completion-sink.test.ts`
(6 tests, all pass) — sync marker, async `.then`/await drain→marker, failure
marker, object/any no-import-leak, sink-only-when-console-used, newline splitting.
`tests/issue-3436-standalone-prelude-leak.test.ts` still passes (6/6).

**Flip-to-pass ceiling (empirical, deterministic-stride sample of real test262
async files, `--target standalone` via `assembleOriginalHarness` + drain + sink):**

| family              | n  | complete (→PASS) | failure (observed) | nothing | CE | inst-throw | import-leak |
| ------------------- | -- | ---------------- | ------------------ | ------- | -- | ---------- | ----------- |
| async-function      | 25 | 23               | 1                  | 0       | 0  | 1          | 0           |
| async-arrow         | 25 | 24               | 0                  | 0       | 0  | 1          | 0           |
| for-await-of        | 25 | 17               | 2                  | 0       | 2  | 4          | 0           |
| Promise-combinator  | 25 | 5                | 1                  | 12      | 0  | 3          | 4           |
| await-expr          | 13 | 4                | 0                  | 0       | 2  | 7          | 0           |
| async-gen           | 25 | 0                | 1                  | 0       | 0  | 0          | 24          |
| **TOTAL**           |138 | **73 (52.9%)**   | 5                  | 12      | 4  | 16         | 28          |

**Honest read:** ~53% of runnable async tests now flip to PASS; another ~4%
produce an observable FAILURE marker. The rest were ALSO failing before (as the
opaque `async completion marker not observed`) and now re-bucket to their honest
signatures: `import-leak` (async-gen / some Promise-combinators need host imports
— the #3178 substrate, pre-existing), `instantiate-throw` (real standalone
feature gaps), `compile-error`, or `nothing` (Promise-combinators a single drain
can't complete). This does NOT claim 2,024 passes; it makes completion OBSERVABLE
for 100% and un-blocks the standalone async scoring effort.

**Verdict-neutrality note:** this runs for every standalone `console.log`. The
async cohort is strictly non-regressing (all were failing). The only pass→fail
surface is a non-async standalone test whose `console.log` arg makes
`__any_to_string` trap where the old `drop` did not — probed with
null/undefined/object/array/Symbol/BigInt/function/class/Map/Error/RegExp: none
trap, zero import leaks. The harness prelude only calls `console.log` inside the
`print` function body (never at top level), so non-async tests that never call
`print`/`console.log` execute none of the new code. Full verdict-neutrality is
confirmed only on the `merge_group` standalone floor — do NOT read PR-green as
neutral.
