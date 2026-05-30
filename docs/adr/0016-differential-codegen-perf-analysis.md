# 16. Differential codegen analysis for performance work

Date: 2026-05-30

## Status

Accepted

## Context

js2wasm targets competitive runtime performance, including parity with JS JITs.
Performance work that starts from a hypothesis ("add SIMD", "unroll the loop")
wastes effort and frequently optimizes the wrong thing — the actual bottleneck is
only visible at the generated-instruction level.

Two facts make a better method possible:

1. **The reference fast implementation exposes its generated code.** V8 compiles
   JS → Ignition bytecode → TurboFan native machine code, and both are dumpable:
   `--print-bytecode` and (with `--allow-natives-syntax` +
   `%OptimizeFunctionOnNextCall`) `--print-opt-code`. Confirmed working in our
   toolchain (Node v25.8.2 ships the disassembler).
2. **Our own output is dumpable too.** We compile JS → Wasm → (Wasmtime/Cranelift)
   → native. Cranelift's output is available via `wasmtime compile --emit-clif`
   or objdump of the `.cwasm`.

So for any hot path we can place *the JIT's native code* next to *our native
code for the same source* and read the divergence directly.

## Decision

**Performance work begins with differential codegen analysis.** Before choosing
an optimization:

1. Dump the reference JIT's native output for the hot function (V8 TurboFan).
2. Dump Cranelift's native output for our compiled Wasm of the same source.
3. Diff the **strategies** (integer-vs-float arithmetic, bounds-check
   elimination, loop unrolling/fusion, vectorization, register pressure, calls
   out to builtins) — not opcode-for-opcode, since the two pipelines emit native
   from different IRs.
4. Let the divergence pick the optimization. Re-diff after each change to confirm
   convergence toward the reference instruction shape.

**Corollary — do not assume an AOT ceiling.** A JIT is constrained to transforms
it can prove safe from *runtime* profiling and pays tier-up cost; an AOT compiler
has full whole-program static analysis and can *compile semantics away* at zero
runtime cost (compile-time constant evaluation, loop-analysis array presizing,
provable loop fusion/unroll, SIMD). JIT-parity-or-better is a legitimate target,
not precluded. Every transform must carry a same-observable-result proof — this
is "compile away, don't emulate" (ADR 0001), never speculative optimization.

## Consequences

- **Data-driven lever selection.** First application (string-hash, #1746): V8's
  hot loop fingerprinted as **176 integer ops / 8 float / 0 SIMD** → the
  match-V8 lever is the i32-typed hash path; SIMD is a *beat-V8* play, not a
  match-V8 one. A hypothesis-first approach would have chased SIMD and missed.
- **Reusable workflow** across all perf issues; pairs with the measurement
  harness (`scripts/generate-wasmtime-hot-runtime.mjs`) and the #1580 benchmark
  staleness gate.
- **Requires** a fast reference implementation to diff against and disassembler
  tooling on both sides (available today).
- Ties perf claims to instruction-level evidence, reducing the risk of "optimized
  the wrong thing" and of stale/ungrounded benchmark numbers.

Related: ADR 0001 (hybrid compilation / compile-away), ADR 0004 (AOT), issue
#1746 (string-hash warm-V8 gap), #1744/#1580 (string-hash perf history).
