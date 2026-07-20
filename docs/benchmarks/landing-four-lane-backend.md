# Landing four-lane backend evidence

Issue #3498 defines a correctness and support matrix for the exact JavaScript
shown by the landing-page competitive benchmark. It does not create benchmark
fixtures or rewrite the four programs. The only accepted sources are:

| Kernel             | Bytes | SHA-256                                                            | Cold oracle          | Runtime oracle           |
| ------------------ | ----: | ------------------------------------------------------------------ | -------------------- | ------------------------ |
| `fib.js`           |   348 | `910ab9ef86bf7ed4c6b7e55c0fe20d93b653dd8bfdb5d48de6ef906778943a73` | `5000 → -1846256875` | `20000000 → -1821818939` |
| `fib-recursive.js` |   318 | `abdd6f6e6c3308220df37f85e7a4c47dc07aba48f4862836dd669809ac53df24` | `10 → 55`            | `30 → 832040`            |
| `array-sum.js`     |   441 | `61affa6e44688788cfdb50f5186078cb55c171f19df2bb104e2dcb9f331cd59c` | `2000 → 1018392`     | `1000000 → 511492320`    |
| `string-hash.js`   |   601 | `66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c` | `100 → 36729899`     | `20000 → 862771296`      |

`object-ops.js` is not part of this matrix.

## Lanes and support semantics

Every result has exactly 16 cells: four kernels by four lanes.

1. `v8-node-exact-source` imports the exact module in Node/V8.
2. `js2-wasmgc-wasmtime-cranelift` compiles the exact module with the existing
   landing options (`wasi`, native strings, optimization level 3), applies the
   existing Binaryen exact-reference normalization, precompiles with Wasmtime,
   and executes with Cranelift. The runner consistently sets
   `experimentalIR:false`; this retains the landing lane's direct-AST
   compatibility method and is disclosed rather than mixing methods by kernel.
3. `js2-shared-plan-porffor-c-native` asks JS2 for source-derived typed SSA and
   the same `LinearMemoryPlan`, passes both directly to the JS2 Porffor IR
   lowerer, renders with the optional pinned Porffor checkout, and builds with
   Clang. It never replans or narrows the shared IR.
4. `plain-porffor-c-native` runs pinned `porf c --module -O1` on the exact file,
   retains that untouched C artifact, and uses the additive #3482 adapter to
   suppress standalone `main` and attach the shared numeric harness. Generated
   accesses are not rewritten. The only generated-C compatibility edit is the
   already disclosed LP64 `printf` cast.

A cell is `supported`, `unsupported`, or `unsafe-non-authoritative`.
Unsupported cells contain no successful validation or timing and must name a
stable phase, code, evidence, and follow-up issue when applicable. A plain
Porffor cell with a sanitizer finding may retain its correctly validated
optimized output, but it is always `unsafe-non-authoritative`; its optimized
timing cannot be used. A JS2 native cell is supported only when its separate
ASan/UBSan executable is clean. Missing cells, skipped-success records, source
substitution, wrong output, synthetic expected-output injection without a
retained observation command, and numeric-zero timing sentinels fail schema
validation. In benchmark mode every executable cell must carry all 5 warmup
plus 21 measured samples for every phase; a support-only document cannot
masquerade as a benchmark.

## Running the probe

Initialize the optional pinned Porffor gitlink, then run:

```sh
pnpm run benchmark:landing-four-lane -- --probe --output .tmp/landing-four-lane
pnpm run benchmark:landing-four-lane -- --validate-result .tmp/landing-four-lane/latest.json
```

Use `--without-porffor` only for the core V8/Wasmtime probe. It still emits all
16 cells; native cells become explicit `optional-dependency` unsupported cells.
The focused test command is `pnpm run test:landing-four-lane`.

The probe records source identity, commands and versions, compile phase wall
times, artifact hashes and sizes, native peak RSS, output vectors, and sanitizer
classification. Its measurement phases are deliberately null with an explicit
`support-probe-only` reason. It does not relabel build or process-startup time as
warm steady-state.

## Capturing measurements

Run a full noncanonical local capture with:

```sh
pnpm run benchmark:landing-four-lane -- --benchmark --output .tmp/landing-four-lane
pnpm run benchmark:landing-four-lane -- --validate-result .tmp/landing-four-lane/latest.json
```

The runner interleaves every executable kernel/lane cell in a rotating order
for 5 warmup and 21 measured outer rounds. Every sample retains positive wall
time and peak RSS, CPU time where the method exposes it, exact invocations, and
an observed output tied to one of those invocations. `latest.json` retains the
raw samples and is authoritative. `summary.md` is a convenience view containing
measured-round-only median wall milliseconds; it does not rank lanes. Unsafe
plain-Porffor medians are marked UB-contaminated and non-authoritative.

The four phases remain distinct:

- **Build:** V8 syntax checking; a fresh worker process for each exact-source
  JS2/Wasm + Binaryen + Cranelift build; or a fresh Porffor/JS2 worker followed
  by Clang. Fresh workers keep compiler caches and peak RSS sample-local.
- **Startup + first call:** a fresh Node, Wasmtime, or native process that
  executes and validates `run(runtimeArg)`. No lane uses a call-free startup
  surrogate.
- **Cold:** V8's established warm-process/fresh-`vm.Context` method,
  `benchmarks/wasmtime-cold-host` with a warm Engine/Module and fresh
  Store/Instance, or native fresh-process initialization plus one call. The
  cold host reports the actual call result alongside its timing.
- **Warm:** the existing warmed V8 child; Wasmtime's appended in-module
  5-warmup/40-measured minimum-time driver plus a retained `landing_validate`
  invocation that returns the actual result; or one native process with six
  warmups and nine individually timed calls whose median is retained. Repeated
  `wasmtime run` process wall time is never presented as warm runtime.

The manual Ubuntu x64 workflow invokes `--benchmark --canonical-ubuntu`, has no
performance threshold, and uploads the complete output directory. Pull-request
CI continues to run the faster support/correctness/sanitizer probe.

## Interpretation boundary

The lanes differ in frontend, numeric ABI, runtime, optimizer, and allocator:
V8/TurboFan, JS2 direct AST plus Binaryen and Wasmtime/Cranelift, JS2 typed SSA
plus shared linear-memory planning and Clang, and boxed plain Porffor plus Clang.
No cross-lane rank is valid without accounting for those confounders. The
workflow is advisory and artifact-only; it applies no performance threshold.
