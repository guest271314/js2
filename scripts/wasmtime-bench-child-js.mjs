/**
 * Spawned by generate-wasmtime-hot-runtime.mjs. Loads a competitive program
 * (a JS module exporting `run(n)`) and reports just the execution time on
 * stdout as JSON. Module-load cost is excluded so the wasm side (which is
 * measured end-to-end via wasmtime CLI wall time) is the conservatively-slow
 * lane, not the JS side.
 *
 * Usage: node [--jitless] wasmtime-bench-child-js.mjs <program.js> <input>
 */
import { pathToFileURL } from "node:url";

const [programPath, inputRaw] = process.argv.slice(2);
if (!programPath || inputRaw == null) {
  process.stderr.write("Usage: node wasmtime-bench-child-js.mjs <program.js> <input>\n");
  process.exit(1);
}

const mod = await import(pathToFileURL(programPath).href);
if (typeof mod.run !== "function") {
  process.stderr.write(`Program ${programPath} does not export run()\n`);
  process.exit(1);
}

const t0 = performance.now();
const result = mod.run(Number(inputRaw));
const execMs = performance.now() - t0;

process.stdout.write(JSON.stringify({ result, execMs }) + "\n");
