---
name: feedback_perf_differential_codegen
description: "For ALL perf work: diff the reference JIT's native code vs our Cranelift native output before optimizing — let data pick the lever; don't assume an AOT ceiling"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

For **all** performance work, START with **differential codegen analysis**, not a hypothesis: dump the native code of the reference-fast implementation AND our shipped output, then diff the *strategies*.

- **Reference (V8 JIT target) — the number we chase:** `node --allow-natives-syntax --print-opt-code --print-opt-code-filter=<fn>` after warming + `%OptimizeFunctionOnNextCall(<fn>)`. Ignition bytecode: `--print-bytecode --print-bytecode-filter=<fn>`. (Our Node v25.8.2 has the disassembler; outputs real ARM64/x86.)
- **Ours (what ships):** `wasmtime compile --emit-clif`, or objdump the `.cwasm`. V8 emits JS→TurboFan→native; we emit JS→Wasm→Cranelift→native — so compare strategies, not opcode-for-opcode.

**Why:** it tells you *which* optimization actually closes the gap, with data instead of guesses. Concrete (2026-05-30, string-hash #1746): V8's hot loop = **176 integer ops / 8 float / 0 SIMD** → the lever is keeping the hash in **i32**; **SIMD is irrelevant for matching V8** (it's a beat-V8 play). Without the diff we'd have chased SIMD and missed.

**How to apply:** (1) capture both disassemblies on the same JS, diff strategies (int-vs-float, bounds-checks, unroll, calls, vectorization); (2) pick the optimization the divergence points at; (3) re-diff after each change to confirm convergence toward the reference shape; (4) **do NOT assume an AOT ceiling** — AOT has compile-time/whole-program leverage a JIT lacks (compile-time const-eval, loop-analysis array presizing, provable fusion/unroll), so JIT-parity-or-better is on the table. Every transform needs a same-observable-result proof ([[feedback_compile_away]], [[feedback_nothing_impossible]]). Decision recorded as ADR docs/adr/0016; method baked into issue #1746.
