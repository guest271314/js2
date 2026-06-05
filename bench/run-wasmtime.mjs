// #1895 — benchmark the three copy paths under wasmtime, on the SAME module.
// Assembles gc-array-copy.wat -> gc-array-copy.wasm (via binaryen) if needed, then
// drives the self-contained run_*(N, rounds) exports via `wasmtime run --invoke`,
// timing the process. For the GC paths it subtracts two round-counts to cancel
// fixed startup+compile+alloc overhead; linear memory.copy is measured absolutely
// (too fast for the difference method to be stable).
//
// Usage: node bench/run-wasmtime.mjs /path/to/wasmtime [N_bytes]
// Requires a GC-capable wasmtime (tested on 44.0.2 and 45.0.0).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import binaryen from "binaryen";

const WT = process.argv[2];
if (!WT) {
  console.error("usage: node run-wasmtime.mjs <wasmtime-binary> [N_bytes]");
  process.exit(1);
}
const WAT = fileURLToPath(new URL("./gc-array-copy.wat", import.meta.url));
const WASM = fileURLToPath(new URL("./gc-array-copy.wasm", import.meta.url));
if (!existsSync(WASM)) {
  const mod = binaryen.parseText(readFileSync(WAT, "utf8"));
  mod.setFeatures(binaryen.Features.All);
  if (!mod.validate()) throw new Error("module failed binaryen validation");
  writeFileSync(WASM, Buffer.from(mod.emitBinary()));
}

const N = Number(process.argv[3]) || 16 * 1024 * 1024;
const MiB = N / 1048576;
const FLAGS = ["run", "-W", "gc=y,function-references=y", "--invoke"];

const time = (fn, rounds) => {
  const t = process.hrtime.bigint();
  execFileSync(WT, [...FLAGS, fn, WASM, String(N), String(rounds)], { stdio: "ignore" });
  return Number(process.hrtime.bigint() - t) / 1e9;
};
const diffTput = (fn, r1, r2) => MiB / ((time(fn, r2) - time(fn, r1)) / (r2 - r1));
const absTput = (fn, r) => (MiB * r) / time(fn, r);

console.log(`${WT.split("/").pop()} — N=${MiB.toFixed(0)} MiB`);
console.log(`  array.copy   ${diffTput("run_arraycopy", 1, 2).toFixed(0).padStart(7)} MiB/s`);
console.log(`  elem-loop    ${diffTput("run_elemloop", 5, 15).toFixed(0).padStart(7)} MiB/s`);
console.log(`  memory.copy  ${absTput("run_memcopy", 2000).toFixed(0).padStart(7)} MiB/s`);
