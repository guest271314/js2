#!/usr/bin/env node
/**
 * Generates the two Wasmtime hot-runtime charts on the landing page:
 *
 *   - benchmarks/results/wasm-host-wasmtime-hot-runtime.json
 *       (JIT enabled — Cranelift backend / `node` default flags)
 *   - benchmarks/results/wasm-host-wasmtime-hot-runtime-no-jit.json
 *       (JIT disabled — Pulley interpreter / `node --jitless`)
 *
 * Methodology
 * -----------
 * For each program in `public/benchmarks/competitive/programs/`:
 *   1. Compile the JS source with `js2wasm` (target=wasi, nativeStrings=true).
 *   2. Precompile the wasm with `wasmtime compile` for both Cranelift (default
 *      JIT) and Pulley (portable interpreter). This mirrors how production
 *      serverless hosts (Fastly Compute, Shopify Functions, Fermyon Spin) ship
 *      already-compiled .cwasm artifacts and load them with
 *      `--allow-precompiled`.
 *   3. For both wasm lanes, spawn `wasmtime run --allow-precompiled --invoke run`
 *      with the program's `runtimeArg`; for both JS lanes, spawn `node`
 *      (default and `--jitless`) and run the same source. Each lane is sampled
 *      N times after a warmup round, and the median wall time is recorded.
 *   4. Two JSON files are written, one per chart, matching the shape that
 *      `<perf-benchmark-chart mode="perf">` expects (per-program rows with
 *      `wasmUs` / `jsUs`).
 *
 * Why Pulley and not Winch for the "JIT disabled" lane
 * ----------------------------------------------------
 * Winch is wasmtime's single-pass baseline compiler — but it doesn't support
 * the GC / function-references proposals that js2wasm's WasmGC output relies
 * on. Pulley is the only wasmtime configuration that runs WasmGC modules
 * without generating native code at runtime (W^X-friendly, the use case that
 * actually motivates "JIT disabled" deployments). This mirrors V8 `--jitless`
 * (Ignition interpreter) on the JS side.
 *
 * Requirements
 * ------------
 *   - `wasmtime` (v35+) on `PATH`.
 *   - The competitive program set under
 *     `public/benchmarks/competitive/programs/*.js`.
 *
 * Output
 * ------
 *   Two JSON arrays of rows, each row matching:
 *     { path, label, wasmUs, jsUs, wasmStdUs, jsStdUs, ratioStd,
 *       warmupRounds, measuredRounds, mode }
 *
 *   The wasmtime CLI is invoked once per measurement; both the JS and wasm
 *   lanes pay equivalent process-startup overhead, and the per-program
 *   `runtimeArg` is sized so internal iteration dominates startup.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compile } from "./compiler-bundle.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PROGRAMS_DIR = resolve(ROOT, "public", "benchmarks", "competitive", "programs");
const ARTIFACT_DIR = resolve(ROOT, ".tmp", "wasmtime-hot-runtime");
const CHILD_JS_PATH = resolve(import.meta.dirname, "wasmtime-bench-child-js.mjs");

const RESULTS_JIT = resolve(ROOT, "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");
const RESULTS_NO_JIT = resolve(ROOT, "benchmarks", "results", "wasm-host-wasmtime-hot-runtime-no-jit.json");
const PUBLIC_JIT = resolve(ROOT, "public", "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");
const PUBLIC_NO_JIT = resolve(ROOT, "public", "benchmarks", "results", "wasm-host-wasmtime-hot-runtime-no-jit.json");

// Programs to include. `object-ops` is excluded because js2wasm emits the
// modern exception-handling proposal for object literal lookups, which
// Cranelift in wasmtime 35 parses but doesn't yet compile.
const PROGRAMS = [
  { id: "fib", label: "Fibonacci loop" },
  { id: "fib-recursive", label: "Fibonacci recursion" },
  { id: "array-sum", label: "Array fill + sum" },
  { id: "string-hash", label: "String build + hash" },
];

const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;
// Wasm features that js2wasm output needs but wasmtime doesn't enable by default.
const WASMTIME_FEATURES = ["-W", "gc=y", "-W", "function-references=y"];

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function ensureWasmtime() {
  try {
    const out = execFileSync("wasmtime", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return out.toString().trim();
  } catch {
    throw new Error("wasmtime not found on PATH. Install from https://wasmtime.dev/ and retry.");
  }
}

function compileProgram(id) {
  const sourcePath = resolve(PROGRAMS_DIR, `${id}.js`);
  const source = readFileSync(sourcePath, "utf8");
  const result = compile(source, { fileName: `${id}.js`, target: "wasi", nativeStrings: true });
  if (!result.success) {
    throw new Error(`Failed to compile ${id}: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  if ((result.imports ?? []).length > 0) {
    throw new Error(
      `Program ${id} has host imports — must be standalone for wasmtime: ${JSON.stringify(result.imports)}`,
    );
  }
  const wasmPath = resolve(ARTIFACT_DIR, `${id}.wasm`);
  writeFileSync(wasmPath, result.binary);
  return { sourcePath, wasmPath };
}

function precompile(wasmPath, id, target) {
  const cwasmPath = resolve(ARTIFACT_DIR, `${id}.${target}.cwasm`);
  const args = ["compile", ...WASMTIME_FEATURES];
  if (target === "pulley") args.push("--target", "pulley64");
  args.push(wasmPath, "-o", cwasmPath);
  execFileSync("wasmtime", args, { stdio: ["ignore", "pipe", "pipe"] });
  return cwasmPath;
}

function readRuntimeArg(sourcePath) {
  const text = readFileSync(sourcePath, "utf8");
  const match = text.match(/runtimeArg:\s*(\d+)/);
  if (!match) throw new Error(`runtimeArg not found in ${sourcePath}`);
  return Number(match[1]);
}

/**
 * Measures wall time of a single `wasmtime run` invocation. Each sample is one
 * fresh process: this includes process startup + module load + `run(arg)`
 * execution. The caller normalizes startup overhead by running twice (one
 * baseline with arg=0 and one with the real runtimeArg) and subtracting the
 * baseline median — see `measureExec`.
 */
function timeWasmtime(cwasmPath, arg, target, runs) {
  const args = ["run", "--allow-precompiled", ...WASMTIME_FEATURES];
  if (target === "pulley") args.push("--target", "pulley64");
  args.push("--invoke", "run", cwasmPath, String(arg));

  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = spawnSync("wasmtime", args, { stdio: ["ignore", "pipe", "pipe"] });
    const ms = performance.now() - t0;
    if (r.status !== 0) {
      throw new Error(`wasmtime ${target} failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`);
    }
    samplesMs.push(ms);
  }
  return samplesMs;
}

function timeNode(sourcePath, arg, jitless, runs) {
  const args = jitless
    ? ["--jitless", CHILD_JS_PATH, sourcePath, String(arg)]
    : [CHILD_JS_PATH, sourcePath, String(arg)];

  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const ms = performance.now() - t0;
    if (r.status !== 0) {
      throw new Error(
        `node ${jitless ? "--jitless " : ""}failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`,
      );
    }
    samplesMs.push(ms);
  }
  return samplesMs;
}

/**
 * Returns per-sample exec-only timings in microseconds. Each sample = (full
 * wall time with runtimeArg) − (median baseline wall time with arg=0). The
 * baseline absorbs process startup, V8/wasmtime engine init, and module load,
 * isolating the function-call cost that the chart's "hot runtime" framing
 * actually claims to measure.
 */
function measureExec(timeFn, runtimeArg) {
  const baselineMs = timeFn(0, WARMUP_RUNS + MEASURED_RUNS).slice(WARMUP_RUNS);
  const fullMs = timeFn(runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(WARMUP_RUNS);
  const baselineMedian = median(baselineMs);
  return fullMs.map((ms) => Math.max(ms - baselineMedian, 0) * 1000);
}

function buildRow(program, wasmSamplesUs, jsSamplesUs, mode) {
  const ratioSamples = wasmSamplesUs.map(
    (us, i) => (jsSamplesUs[i] ?? jsSamplesUs[jsSamplesUs.length - 1]) / Math.max(us, 0.000001),
  );
  return {
    path: `programs/${program.id}.js`,
    name: program.id,
    label: program.label,
    mode,
    wasmUs: median(wasmSamplesUs),
    jsUs: median(jsSamplesUs),
    wasmStdUs: stddev(wasmSamplesUs),
    jsStdUs: stddev(jsSamplesUs),
    ratioStd: stddev(ratioSamples),
    warmupRounds: WARMUP_RUNS,
    measuredRounds: MEASURED_RUNS,
  };
}

function writeOutput(rows, primaryPath, publicPath) {
  mkdirSync(dirname(primaryPath), { recursive: true });
  writeFileSync(primaryPath, JSON.stringify(rows, null, 2) + "\n");
  mkdirSync(dirname(publicPath), { recursive: true });
  copyFileSync(primaryPath, publicPath);
  console.log(`Updated ${primaryPath}`);
  console.log(`Updated ${publicPath}`);
}

async function main() {
  const version = ensureWasmtime();
  console.log(`Using ${version}`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const jitRows = [];
  const noJitRows = [];

  for (const program of PROGRAMS) {
    process.stdout.write(`\n[${program.id}] compiling... `);
    const { sourcePath, wasmPath } = compileProgram(program.id);
    const runtimeArg = readRuntimeArg(sourcePath);
    process.stdout.write(`runtimeArg=${runtimeArg}\n`);

    process.stdout.write(`[${program.id}] precompiling cranelift... `);
    const craneliftPath = precompile(wasmPath, program.id, "cranelift");
    process.stdout.write(`ok\n`);

    process.stdout.write(`[${program.id}] precompiling pulley... `);
    const pulleyPath = precompile(wasmPath, program.id, "pulley");
    process.stdout.write(`ok\n`);

    process.stdout.write(`[${program.id}] measuring node (jit)... `);
    const nodeJitUs = measureExec((arg, runs) => timeNode(sourcePath, arg, false, runs), runtimeArg);
    process.stdout.write(`${(median(nodeJitUs) / 1000).toFixed(1)} ms (exec, startup subtracted)\n`);

    process.stdout.write(`[${program.id}] measuring node (--jitless)... `);
    const nodeJitlessUs = measureExec((arg, runs) => timeNode(sourcePath, arg, true, runs), runtimeArg);
    process.stdout.write(`${(median(nodeJitlessUs) / 1000).toFixed(1)} ms (exec, startup subtracted)\n`);

    process.stdout.write(`[${program.id}] measuring wasmtime (cranelift)... `);
    const craneliftUs = measureExec((arg, runs) => timeWasmtime(craneliftPath, arg, "cranelift", runs), runtimeArg);
    process.stdout.write(`${(median(craneliftUs) / 1000).toFixed(1)} ms (exec, startup subtracted)\n`);

    process.stdout.write(`[${program.id}] measuring wasmtime (pulley)... `);
    const pulleyUs = measureExec((arg, runs) => timeWasmtime(pulleyPath, arg, "pulley", runs), runtimeArg);
    process.stdout.write(`${(median(pulleyUs) / 1000).toFixed(1)} ms (exec, startup subtracted)\n`);

    jitRows.push(buildRow(program, craneliftUs, nodeJitUs, "jit"));
    noJitRows.push(buildRow(program, pulleyUs, nodeJitlessUs, "no-jit"));
  }

  writeOutput(jitRows, RESULTS_JIT, PUBLIC_JIT);
  writeOutput(noJitRows, RESULTS_NO_JIT, PUBLIC_NO_JIT);

  try {
    rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; .tmp is gitignored
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
