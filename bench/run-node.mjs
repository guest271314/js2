// #1895 — assemble gc-array-copy.wat and benchmark the three copy paths under
// Node/V8 (WasmGC). Prints MiB/s for array.copy, element-loop, linear memory.copy.
// Usage: node bench/run-node.mjs [N_bytes] [rounds]
//
// Uses the `binaryen` dep to assemble the .wat (it parses the GC text format and
// emits .wasm). If you have wasm-tools/wat2wasm you can instead pre-assemble:
//   wasm-tools parse bench/gc-array-copy.wat -o bench/gc-array-copy.wasm
import { readFileSync } from "node:fs";
import binaryen from "binaryen";

const N = Number(process.argv[2]) || 16 * 1024 * 1024; // 16 MiB
const R = Number(process.argv[3]) || 50;

const mod = binaryen.parseText(readFileSync(new URL("./gc-array-copy.wat", import.meta.url), "utf8"));
mod.setFeatures(binaryen.Features.All); // GC + ref-types + bulk-memory (+ deps)
if (!mod.validate()) throw new Error("module failed binaryen validation");
const { instance } = await WebAssembly.instantiate(mod.emitBinary(), {});
const { alloc, bench_arraycopy, bench_elemloop, bench_memcopy } = instance.exports;

alloc(N);
console.log(`Node ${process.version} (V8 WasmGC) — N=${(N / 1048576).toFixed(0)} MiB, ${R} rounds`);
for (const [name, fn] of [
  ["array.copy", bench_arraycopy],
  ["elem-loop", bench_elemloop],
  ["memory.copy", bench_memcopy],
]) {
  fn(1); // warm
  const t = performance.now();
  fn(R);
  const sec = (performance.now() - t) / 1000;
  console.log(`  ${name.padEnd(12)} ${((N * R) / 1048576 / sec).toFixed(0).padStart(7)} MiB/s`);
}
