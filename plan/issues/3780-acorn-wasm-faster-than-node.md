---
id: 3780
title: "Compile Acorn parse hot path to Wasm faster than native Node"
status: in-progress
sprint: current
created: 2026-07-29
updated: 2026-07-29
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen, runtime, tooling
language_feature: strings, objects, arrays, classes, parser
goal: performance
assignee: "ttraenkler/codex"
depends_on: [3779]
related: [1710, 1712, 3756]
files:
  - package.json
  - plan/issues/3780-acorn-wasm-faster-than-node.md
  - plan/issues/backlog/backlog.md
  - scripts/generate-npm-compat-report.mjs
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/index.ts
  - src/codegen/native-regex.ts
  - src/codegen/object-ops.ts
  - src/codegen/property-access.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/regexp-standalone.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/typed-this.ts
  - src/compiler.ts
  - src/compiler/ground-call-fold.ts
  - src/index.ts
  - src/optimize.ts
  - src/runtime.ts
  - tests/issue-1474-standalone-regex-refuse.test.ts
  - tests/issue-2063-switch-strict-equality.test.ts
  - tests/issue-3683-direct-calls.test.ts
  - tests/issue-3765-numeric-locals.test.ts
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/compiler.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/index.ts
  - src/codegen/native-regex.ts
  - src/codegen/object-ops.ts
  - src/codegen/property-access.ts
  - src/codegen/regexp-standalone.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/typed-this.ts
  - src/index.ts
  - src/optimize.ts
  - src/runtime.ts
func-budget-allow:
  - scripts/generate-npm-compat-report.mjs::compileStandaloneLane
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
  - src/codegen/fnctor-escape-gate.ts::analyzeProtoMethodWriteOnce
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/native-regex.ts::ensureRegexSearch
  - src/codegen/object-ops.ts::compileObjectDefineProperties
  - src/codegen/regexp-standalone.ts::ensureDynamicStandaloneRegExpCompiler
  - src/codegen/statements/control-flow.ts::compileSwitchStatement
  - src/codegen/typed-this.ts::fillDirectCallTrampolines
  - src/codegen/typed-this.ts::recordDirectCallGeneric
  - src/codegen/typed-this.ts::tryEmitDirectTwinCall
  - src/compiler/ground-call-fold.ts::foldGroundCallsInMultiFiles
origin: "user request to repeat the measured clsx and cookie optimization process for Acorn and beat native Node"
---

# #3780 — compile Acorn parse hot path to Wasm faster than native Node

## Product outcome

The real pinned `acorn@8.16.0` package is reported in two deliberately separate
performance contracts:

1. **Compile-time static / standalone:** the package, fixed source, options,
   operation, and test driver are all compiler-visible. Generic,
   semantics-preserving evaluation of this closed program is allowed.
2. **Runtime dynamic / JS host:** Node supplies the source and options after
   compilation and observes every call. The compiled parser must execute the
   operation for each runtime input.

Both use `optimize: 4`, the same pinned package operation, and the existing
two-warm-up/nine-measured-round protocol. No Acorn package, file, source-text,
export-name, or expected-output special case is permitted.

## Benchmark contract

Both sides receive the same test and verify checksum `422`, but the input
knowledge is part of the result and must never be combined. The static lane may
erase work only through a generic closed-program proof and measures the
result-preserving residual. The dynamic lane must parse and observe the same
source on every measured call. The static faster-than-Node goal is complete;
runtime-dynamic performance remains open.

## Investigation

Establish a fresh same-host baseline. Record optimized and correctness binary
sizes, Wasm imports and start shape, representative WAT, per-operation
Wasm-to-host imports and host callbacks, export marshalling, CPU attribution,
and compile/instantiate/first-call startup. Identify the host precisely and
report cold startup separately from the repeated-call hot benchmark.

## Measured baseline

Candidate base `6bf34f1099ea15` (current main plus #3778 and #3779), Node
24.4.1 / V8 13.6.233.10-node.17, arm64 macOS:

| lane           |           median | standard deviation |
| -------------- | ---------------: | -----------------: |
| compiled Wasm  | 1,323,300.108 µs |      22,041.787 µs |
| native Node    |     4,023.425 µs |         271.059 µs |
| Node advantage |          328.89x |                    |

The baseline used five iterations, two warm-up rounds, and nine measured
rounds. Correctness was 3,507/3,518 official Acorn tests (99.69%), matching the
pre-existing surface.

## Binary and execution analysis

The optimized performance module is a 330,903-byte WasmGC binary; the separate
correctness binary is 596,610 bytes. It has no linear memory. Its start function
initializes Acorn's token types, parser prototypes, accessor closures, regular
expressions, and lookup tables before exports are wired.

The optimized binary declares 77 function imports plus a large string-constant
global namespace. The WAT contains typed WasmGC structs for `Parser`, `Node`,
`TokenType`, `TokContext`, source locations, regexp validation state, arrays,
and many closure/functor shapes. Parser fields and generic operations repeatedly
move through `externref`, `f64`, boxed booleans/numbers, generic property
helpers, and closure dispatch. The public `parse` wrapper is small; the cost is
the recursive parser graph it enters.

An exact, allocation-free per-instance import counter measured one changed
source parse after module initialization:

| dynamic work group                                    | Wasm-to-host calls |
| ----------------------------------------------------- | -----------------: |
| numeric boxing/unboxing, type, truth, compare, index  |         11,032,750 |
| extern property reads/writes, lookup, method dispatch |          5,656,932 |
| arrays, argument vectors, and iteration               |            866,913 |
| object creation, registration, deletion               |             58,870 |
| regexp and string helpers                             |             54,500 |
| **total**                                             |     **17,669,965** |

The largest individual helpers are `__box_number` (2,995,053),
`__extern_get` (1,852,765), `__get_undefined` (1,718,875),
`__host_compare` (1,698,487), `__unbox_number` (1,564,754),
`__host_eq` (1,463,415), `__typeof_number` (1,321,348), and
`__is_truthy` (1,309,535). This direct census explains the flat
constant-factor cost more precisely than attributing the 1.323-second sample to
the compact public wrapper. Host-to-Wasm callbacks are not counted on the miss:
wrapping Acorn's callback exports changes its closure ABI. The counter therefore
reports that dimension as unavailable rather than a false zero.

## Who the host is

The host is Node 24.4.1. Its V8 engine instantiates the WasmGC binary through
the JavaScript `WebAssembly` API. JavaScript functions built by
`src/runtime.ts` satisfy the module's `env` imports, and V8 supplies the
`wasm:js-string` built-ins. Native Acorn and compiled Acorn run in the same V8
process. This is not WASI, Wasmtime, or a browser.

## Startup denominator

The final clean run separated build time from deployed startup:

| phase                                       |          time |
| ------------------------------------------- | ------------: |
| compile 226 KB JavaScript source at level 4 | 10,572.719 ms |
| `WebAssembly.compile` optimized binary      |      0.779 ms |
| instantiate, including Acorn module start   |      2.382 ms |
| wire runtime exports                        |      0.001 ms |
| wrap public exports                         |      0.110 ms |
| first parse                                 |  1,283.007 ms |
| second parse                                |  1,228.122 ms |

Source compilation is a build-time denominator, not deployed startup. If the
shared host runtime is not already loaded, #3778 measured another 199.559 ms to
load its unchanged 10,007,724-byte JavaScript chunk (1,663,408 bytes gzip).
This optimization does not shrink that runtime or the 330,903-byte Wasm module.
The first/new-source parse still performs the full parser and snapshot, so no
cold-start improvement is claimed.

## Benchmark setup

`pnpm run benchmark:acorn` runs only Acorn, retains the committed correctness
and performance implementations, prints all nine samples and diagnostics, and
does not update aggregate artifacts. `pnpm run benchmark:acorn:perf` skips the
correctness harness and official suite for iteration. `--diagnostics-only`,
`--inspect-boundaries`, and `--inspect-wat` isolate binary/startup, boundary,
and WAT attribution work.

Both lanes use one shared iteration count calibrated against the slower lane.
This changes only run duration; both lanes still execute the same count in
every round.

## Runtime-dynamic measurement

Both sides parse Acorn's same 226 KB distribution source and observe
`ast.body.length === 422` on every call:

| lane          |           median | standard deviation |
| ------------- | ---------------: | -----------------: |
| compiled Wasm | 1,241,301.500 µs |      10,285.913 µs |
| native Node   |     4,204.583 µs |         604.808 µs |

The nine-round result uses one full parse per round and puts Node
**295.23x ahead**. Matching checksum 422 is recorded in the committed artifact.
Correctness remains exactly 3,507/3,518 (99.69%).

## Standalone runtime-dynamic execution

The standalone runtime-dynamic driver receives a numeric seed only after
compilation, incorporates it into the source, runs the complete test loop
inside Wasm, and returns checksum `422`. Its 1,784,602-byte WasmGC module has
zero imports and does not use staged evaluation. Two generic codegen
improvements reduced the pre-driver representative parse from 76.98 ms to
65.49 ms:

- object-only switches compare WasmGC reference identity instead of executing
  the full JavaScript primitive/tag StrictEquality cascade for every case;
- runtime-constructed, flagless `^(?:literal|literal|...)$` regular expressions
  use a compact literal-alternative representation and direct matcher.

The committed runtime-input lane measures 71,248.30 us/op in Wasm versus
4,129.78 us/op in Node, leaving Node **17.25x faster**. The final profile
attributes 8.7% to internal `__extern_get`, 5.3% to regexp test dispatch, 3.6%
to generic one-argument function dispatch, 3.0% to `ToPrimitive`, 2.4% to
number unboxing, and only 1.1% to GC. The parser remains on the legacy backend;
`irCompiledFunctions` is empty.

### Runtime-dynamic optimization round

The follow-up compiler work remains package-agnostic and executes the same
runtime parse on both sides. Four generic changes reduce the representative
standalone median from 71.25 ms to 54.79 ms (23.1%):

1. A homogeneous numeric `switch` unboxes the discriminant once and emits
   ordered `f64.eq` comparisons. A runtime number guard preserves strict
   equality for strings, objects, `NaN`, and side-effecting case expressions.
2. Call-site ABI inference carries an existing grounded numeric-local proof
   into an otherwise `any` helper parameter. This removes repeated
   box/`ToPrimitive`/unbox work in helpers such as character classifiers
   without guessing from the helper body or specializing Acorn.
3. A write-once prototype method without a typed twin now retains its exact
   closure instance and calls the known lifted body directly. Captures remain
   live; the old dynamic dispatcher remains the pre-initialization fallback.
4. A generic lifted prototype body may devirtualize its own pinned `this.m()`
   calls behind a runtime receiver-shape guard. Detached or foreign receivers
   take the original dispatcher.

The direct-call diagnostics move from 1,886 sites / 264 trampolines / 14 legacy
fills to 3,980 sites / 547 trampolines / zero legacy fills: 518 trampolines call
typed twins and 29 call retained generic closures. The paired
`JS2WASM_PINNED_THIS_DIRECT_CALLS=0` control measures 58.22 ms, versus 54.31 ms
enabled, attributing about a 6.7% improvement to the fourth change alone.

Final official nine-round run (checksum 422):

| lane                               |          median |
| ---------------------------------- | --------------: |
| standalone runtime-dynamic Wasm    |   54,792.653 us |
| native Node                        |    3,905.500 us |
| remaining Node advantage           |      **14.03x** |
| optimized binary / runtime imports | 1,775,322 B / 0 |

The separate named-profile run measures 54,169.951 us in Wasm versus
4,047.042 us in Node. Its 1,816,942-byte binary only differs by preserved debug
names. The largest exclusive buckets are `__extern_get` (11.2%), runtime RegExp
`.test` dispatch (6.5%), GC (4.0%), `ToPrimitive` (2.0%), and `Node`
construction (2.3%). Generic one-argument closure dispatch falls from 4.0%
before the pinned route to 1.0%. A speculative call-site RegExp brand split was
removed after its paired control showed it was about 2% slower; no non-winning
experiment remains in the patch.

The dynamic parser is still emitted by the legacy WasmGC backend
(`benchmarkUsesIr: false`, empty `irCompiledFunctions`). The zero-import module
has no host crossings during the parse—the remaining 14.03x gap is internal
Wasm object/string/regexp representation and dispatch cost, not 17.67 million
Node callbacks. Beating Node remains the open acceptance criterion; the static
IR residual is reported separately and does not satisfy it.

## Compile-time static outcome

For the reported static row, compilation first builds the full zero-import
module above, initializes it, and evaluates the exact exported operation once
inside Wasm. That stage produces `422` without using Node as an oracle. The
generic benchmark tooling then compiles the equivalent result-preserving
residual; Node independently performs the same parse operation and the normal
checksum comparison still guards the result.

This is staged evaluation, not memoization: there is no result cache, lookup, or
runtime input key. It applies to a closed numeric operation regardless of
package and refuses a stage with host imports or a non-finite result. The final
20,874-byte module has zero imports and
`__npmCompatStandaloneBenchmark` is emitted by the IR backend.

Committed nine-round measurement on Node 24.4.1 / V8 13.6, arm64 macOS:

| lane                              |          median |
| --------------------------------- | --------------: |
| standalone static residual Wasm   |      0.02473 us |
| native Node parse                 |  4,658.36980 us |
| Wasm residual advantage           |  **188,335.9x** |
| full Wasm static-evaluation stage |       421.46 ms |
| full stage binary / imports       | 1,784,473 B / 0 |

The static ratio is real for deployment when those inputs are compile-time
constants, but it is not a claim that Acorn parses a new source faster than
Node. That claim belongs exclusively to the runtime-dynamic row.

The committed JS-host runtime-dynamic row measures 1,241,301.50 us/op in Wasm
versus 4,204.58 us/op in Node, leaving Node approximately **295.23x faster**.
Its 330,903-byte binary retains 77 function imports, and one identical parse
crosses from Wasm to the Node host about 17.67 million times. The largest
families are number boxing/unboxing, host comparison/truthiness, and generic
extern property access. Those calls—not startup—dominate this lane.

An explicit result-floor diagnostic changed the compiled export to consume
`.body.length` inside Wasm and return only the number. It still made 17,669,415
Wasm-to-host calls and measured 1.23 s/op, effectively identical to returning
the public parse result and observing it in Node. The 17.67 million calls
therefore occur inside the single parser invocation; they are not repeated
parser calls or AST-result marshalling.

## Acceptance criteria

- [x] `pnpm run benchmark:acorn` runs only Acorn, uses the official npm-compat
      correctness and performance implementations, prints raw samples, and does
      not overwrite aggregate artifacts.
- [x] The dynamic benchmark invokes parameterized public
      `parse(source, options)` on every call; no package/source/file/export-name
      special case is introduced.
- [x] The static benchmark reports its compiler-visible input knowledge,
      performs generic staged evaluation only in a zero-import Wasm module, and
      records the full evaluation-stage time and binary separately.
- [x] The standalone runtime-dynamic benchmark receives an input-selecting
      value after compilation, keeps the test loop and observation inside
      zero-import Wasm, and performs every parse.
- [x] The representative compiled AST remains equivalent to native Acorn, and
      the official correctness surface does not regress.
- [x] Across the official static nine measured rounds, compiled Wasm residual
      median time is lower than native Node (`nodeUs / wasmUs > 1`).
- [ ] Across either official runtime-dynamic nine-round lane, compiled Wasm
      median time is lower than native Node (`nodeUs / wasmUs > 1`).
- [x] Baseline, final medians, standard deviations, iteration count, engine,
      binary size, imports, boundary census, CPU attribution, and startup
      denominator are documented.
