#!/usr/bin/env node
/**
 * Generates the Wasmtime-vs-V8 per-request comparison data for the landing
 * page chart `<perf-benchmark-chart src="…hot-runtime.json">`.
 *
 * The page positions this as a generic edge-serverless comparison between
 * two production runtime architectures: an AOT-compiled Wasm edge runtime
 * (Wasmtime + AOT-precompiled `.cwasm`, pre-instantiated module) vs a
 * V8-isolate edge runtime (V8 isolate-per-request). Both run untrusted code
 * per request, but with very different cost models for fresh-vs-reused
 * execution contexts. No specific commercial platform is named — the lanes
 * describe the *architecture/scenario*, not a product.
 *
 * NOTE (#1764): the **cold** lane below currently measures full OS-process
 * spawns (`wasmtime run` / `node script.js`), which is the true cold-process
 * worst case, NOT how production edge runtimes serve a cold request.
 * Production keeps the engine/runtime warm and pays only a lightweight
 * per-request context/instance cost. #1764 specs replacing the process-spawn
 * cold lane with a warm-engine, per-request instantiation model for both
 * lanes (new context / new Instance from a long-lived engine). Until that
 * lands, read the cold numbers as "full cold-process", not "edge cold-start".
 *
 * Two scenarios per program (8 rows total):
 *
 *   1. **Per-request cold (currently: fresh process per request)**
 *      Today this models the worst-case full cold-process request: a request
 *      arrives, no pre-warmed runtime exists, the runtime boots from scratch.
 *      - Wasm lane: full `wasmtime run --allow-precompiled` wall time
 *        (wasmtime startup ~ms + cwasm `mmap` + signature check + `run(arg)`).
 *      - JS lane: full `node script.js` wall time (V8 startup + module parse
 *        + Ignition → Liftoff → first invocation).
 *      Both include process startup. Per #1764 this will move to "new
 *      context / new Instance from a warm engine (µs–ms)", which is the
 *      representative edge cold-start cost.
 *
 *   2. **Warm isolate / reused instance (steady state)**
 *      Models the common-case edge request: the runtime has already served a
 *      request, the isolate/instance is reused, optimizing tiers have
 *      completed.
 *      - Wasm lane (#1760): one `wasmtime run --invoke warm` process whose
 *        appended `warm` export calls `run(arg)` a few warmup times then
 *        times many in-process iterations via CLOCK_MONOTONIC and returns
 *        the steady-state minimum per-call ms. Process startup is amortized
 *        across all iterations — NOT recovered by subtracting two noisy
 *        full-process wall-times (the previous cold−baseline method had a
 *        ~2.3× run-to-run spread that swamped any few-ms per-call signal).
 *      - JS lane: spawn `node` once, call `mod.run(arg)` WARMUP times so
 *        TurboFan tiers up, then time MEASURED more in-process iterations
 *        and report the median. This is what a warm V8-isolate edge runtime
 *        actually pays once an optimizing tier has built up.
 *
 * Why no Pulley / no-JIT lane: Pulley is a portability/dev tool in
 * Wasmtime, not a production serverless config (production Wasm edge runtimes
 * use Cranelift-compiled native code). Including it confused the message;
 * the genuine comparison is Cranelift AOT vs V8 JIT.
 *
 * ## Javy + StarlingMonkey lanes
 *
 * The hot-runtime JSON also carries `javyUs` and `starlingMonkeyUs` per row
 * so the landing-page chart can render four lanes: js2wasm AOT, V8 with JIT,
 * Javy (interpreter), StarlingMonkey (engine).
 *
 * Those two values are NOT measured by this script — they require:
 *   - wasmtime ≥ 40 (for component `--invoke "fn(args)"` syntax)
 *   - javy + javy-default-plugin-v3 (dynamic-link plugin mode)
 *   - @bytecodealliance/componentize-js ≥ 0.20.0 + Wizer + Weval AOT
 *
 * The full four-lane harness lives in the labs repo under
 * `benchmarks/compare-runtimes.ts` + `benchmarks/competitive/`. This script
 * (the public landing-page generator) carries the verified Javy /
 * StarlingMonkey numbers forward from that harness; refresh them when the
 * labs run produces new measurements by editing JAVY_NUMBERS_MS /
 * STARLINGMONKEY_NUMBERS_MS below.
 *
 * Requirements: `wasmtime` (v35+) on PATH; competitive programs under
 * `public/benchmarks/competitive/programs/*.js`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compile } from "./compiler-bundle.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PROGRAMS_DIR = resolve(ROOT, "website", "public", "benchmarks", "competitive", "programs");
const ARTIFACT_DIR = resolve(ROOT, ".tmp", "wasmtime-hot-runtime");
const CHILD_JS_PATH = resolve(import.meta.dirname, "wasmtime-bench-child-js.mjs");

const RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");
const PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");

// `object-ops` excluded: js2wasm emits the modern exception-handling
// proposal for object literal lookups, which Cranelift in wasmtime 35
// parses but doesn't yet compile.
const PROGRAMS = [
  { id: "fib", label: "Fibonacci loop" },
  { id: "fib-recursive", label: "Fibonacci recursion" },
  { id: "array-sum", label: "Array fill + sum" },
  { id: "string-hash", label: "String build + hash" },
];

const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;
const WASMTIME_FEATURES = ["-W", "gc=y", "-W", "function-references=y"];

// #1760: in-process repeated-measure warm driver.
//
// The previous warm metric derived `warm = (full-process cold wall-time) −
// (baseline arg=0 wall-time)` — subtracting two ~30 ms `wasmtime run` process
// wall-times to recover a few-ms per-call signal. Process-startup jitter
// (~ms-scale) swamped the signal: 6 back-to-back runs of string-hash on an
// IDENTICAL binary spanned 5.43–12.31 ms (a ~2.3× spread), so a genuine
// per-call codegen win (e.g. #1746's i32 hash path) was unresolvable.
//
// The fix mirrors the V8 warm lane (`timeNodeWarmIter`): amortize the
// one-time wasmtime/Cranelift startup over many in-process iterations of the
// hot function and report the steady-state per-call time. We append a `warm`
// export to each program that calls `run(n)` a few warmup times (to settle
// caches/branch predictors — Cranelift AOT code does not tier up, so this is
// short) then times WARM_ITERS_MEASURED in-process iterations via
// `performance.now()` (CLOCK_MONOTONIC inside wasmtime, sub-ms resolution)
// and returns the MINIMUM per-call ms — the steady-state floor, the least
// scheduler-noise-contaminated estimator. One `wasmtime run --invoke warm`
// process → startup amortized across all iterations. We spawn that process
// MEASURED_RUNS times to get a sample array for the std-dev/median the chart
// consumes, exactly parallel to the V8 lane.
//
// The driver is plain JS with a JSDoc `@param {number}` so the export takes a
// numeric (not boxed externref) argument — matching how the program files
// already type `run` — and so wasmtime `--invoke` can pass the runtimeArg.
// `__sink` keeps `run()`'s result observable so the body isn't DCE'd.
const WARM_ITERS_WARMUP = 5;
const WARM_ITERS_MEASURED = 40;
const WARM_DRIVER_SOURCE = `
/** @param {number} __n @returns {number} */
export function warm(__n) {
  for (let __w = 0; __w < ${WARM_ITERS_WARMUP}; __w++) { run(__n); }
  let __best = 1e18;
  let __sink = 0;
  for (let __m = 0; __m < ${WARM_ITERS_MEASURED}; __m++) {
    const __t0 = performance.now();
    const __r = run(__n);
    const __dt = performance.now() - __t0;
    __sink = (__sink + __r) | 0;
    if (__dt < __best) __best = __dt;
  }
  if (__sink === 0x7fffffff) return -1;
  return __best;
}
`;

// Javy + StarlingMonkey verified numbers (2026-04-27 wasmtime 44.0.0,
// aarch64-linux) — see labs benchmarks/compare-runtimes.ts.
// Map: `cold` → README "Cold ms" (process startup + first call);
//      `warm` → README "Compute-only ms" (steady-state per call).
// Programs not present in either table fall back to 0 (omitted from chart).
const JAVY_NUMBERS_MS = {
  fib: { cold: 28.8, warm: 1193.2 },
  "fib-recursive": { cold: 31.2, warm: 87.9 },
  "array-sum": { cold: 28.0, warm: 112.9 },
  "string-hash": { cold: 30.7, warm: 36.0 },
};
const STARLINGMONKEY_NUMBERS_MS = {
  fib: { cold: 37.2, warm: 1024.3 },
  "fib-recursive": { cold: 26.4, warm: 156.7 },
  "array-sum": { cold: 31.0, warm: 125.5 },
  "string-hash": { cold: 30.5, warm: 14.2 },
};
const LANES_PROVENANCE =
  "javyUs/starlingMonkeyUs from verified 2026-04-27 wasmtime 44.0.0 aarch64-linux " +
  "labs measurements (compare-runtimes.ts). Javy = dynamic-link " +
  "with javy-default-plugin-v3 preload. StarlingMonkey = ComponentizeJS 0.20.0 + " +
  "Wizer + Weval AOT.";

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

async function compileProgram(id) {
  const sourcePath = resolve(PROGRAMS_DIR, `${id}.js`);
  const source = readFileSync(sourcePath, "utf8");
  // #1580: enable `-O3` post-processing via Binaryen wasm-opt. The unoptimized
  // emitter spills a fresh `$NativeString` struct on every `s.length` /
  // `s.charCodeAt(i)` read inside hot loops; wasm-opt's SROA collapses those
  // allocations and turns the string-hash inner loop into a tight
  // `array.get_u $u16Array` sequence, bringing it within ~3× of V8 with JIT
  // (instead of the previous Interpreter-class ~63ms). The optimizer is also
  // a no-op when wasm-opt isn't available — `compile` returns the unoptimized
  // binary plus a warning we surface below.
  const result = await compile(source, { fileName: `${id}.js`, target: "wasi", nativeStrings: true, optimize: 3 });
  if (!result.success) {
    throw new Error(`Failed to compile ${id}: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  // Surface optimization warnings so a missing wasm-opt or a validator
  // rejection is visible in the script output rather than silently producing
  // an "Interpreter-class" hot-runtime number.
  for (const err of result.errors ?? []) {
    if (err.severity === "warning") {
      console.warn(`[${id}] ${err.message}`);
    }
  }
  if ((result.imports ?? []).length > 0) {
    throw new Error(
      `Program ${id} has host imports — must be standalone for wasmtime: ${JSON.stringify(result.imports)}`,
    );
  }
  const wasmPath = resolve(ARTIFACT_DIR, `${id}.wasm`);
  writeFileSync(wasmPath, result.binary);

  // #1760: also compile a warm variant — the original program plus an
  // appended self-timing `warm` export (see WARM_DRIVER_SOURCE). The
  // `export const benchmark = {…}` metadata block is stripped first so it
  // doesn't add an unused export to the standalone module. The warm module
  // is compiled with the IDENTICAL options (target/nativeStrings/optimize)
  // so its `run` lowering is bit-for-bit what the cold lane measures.
  const programBody = source.replace(/export const benchmark[\s\S]*?};\n/, "");
  const warmSource = programBody + "\n" + WARM_DRIVER_SOURCE;
  const warmResult = await compile(warmSource, {
    fileName: `${id}-warm.js`,
    target: "wasi",
    nativeStrings: true,
    optimize: 3,
  });
  if (!warmResult.success) {
    throw new Error(`Failed to compile ${id} warm driver: ${warmResult.errors?.[0]?.message ?? "unknown error"}`);
  }
  for (const err of warmResult.errors ?? []) {
    if (err.severity === "warning") {
      console.warn(`[${id}-warm] ${err.message}`);
    }
  }
  if ((warmResult.imports ?? []).length > 0) {
    throw new Error(
      `Program ${id} warm driver has host imports — must be standalone for wasmtime: ${JSON.stringify(warmResult.imports)}`,
    );
  }
  const warmWasmPath = resolve(ARTIFACT_DIR, `${id}-warm.wasm`);
  writeFileSync(warmWasmPath, warmResult.binary);

  return { sourcePath, wasmPath, warmWasmPath };
}

function precompile(wasmPath, label) {
  const cwasmPath = resolve(ARTIFACT_DIR, `${label}.cranelift.cwasm`);
  const args = ["compile", ...WASMTIME_FEATURES, wasmPath, "-o", cwasmPath];
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
 * Wall time of N `wasmtime run` invocations, each a fresh process.
 * Returns per-sample milliseconds.
 */
function timeWasmtime(cwasmPath, arg, runs) {
  const cmdArgs = ["run", "--allow-precompiled", ...WASMTIME_FEATURES, "--invoke", "run", cwasmPath, String(arg)];
  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = spawnSync("wasmtime", cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const ms = performance.now() - t0;
    if (r.status !== 0) {
      throw new Error(`wasmtime failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`);
    }
    samplesMs.push(ms);
  }
  return samplesMs;
}

/**
 * #1760: in-process warm wasm lane. Spawns one `wasmtime run --invoke warm`
 * process per outer sample. Inside each process the appended `warm` export
 * does WARM_ITERS_WARMUP warmups then times WARM_ITERS_MEASURED in-process
 * iterations of `run(arg)` via CLOCK_MONOTONIC and returns the MINIMUM
 * per-call ms (steady-state floor). Each process's returned value is one
 * outer-sample value. Returns per-outer-sample milliseconds. Mirrors
 * `timeNodeWarmIter` so the warm wasm and warm v8 lanes are constructed the
 * same way (startup amortized over many in-process iterations, not recovered
 * by subtracting two noisy full-process wall-times).
 */
function timeWasmtimeWarmIter(cwasmPath, arg, outerRuns) {
  const cmdArgs = ["run", "--allow-precompiled", ...WASMTIME_FEATURES, "--invoke", "warm", cwasmPath, String(arg)];
  const samplesMs = [];
  for (let i = 0; i < outerRuns; i++) {
    const r = spawnSync("wasmtime", cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) {
      throw new Error(`wasmtime warm failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`);
    }
    // `--invoke` prints the f64 return value (the min per-call ms) on stdout.
    // It also emits experimental-feature warnings to stderr; parse the last
    // non-empty stdout line as the numeric result.
    const out = (r.stdout ?? "").toString().trim().split("\n").pop();
    const perCallMs = Number(out);
    if (!Number.isFinite(perCallMs) || perCallMs <= 0) {
      throw new Error(`wasmtime warm did not return a positive per-call ms: ${JSON.stringify(out)}`);
    }
    samplesMs.push(perCallMs);
  }
  return samplesMs;
}

/**
 * Wall time of N `node script.js` invocations in "single" mode. Each sample
 * is one fresh node process: V8 boot, parse, single call to run().
 */
function timeNodeColdProcess(sourcePath, arg, runs) {
  const cmdArgs = [CHILD_JS_PATH, "--mode=single", sourcePath, String(arg)];
  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const ms = performance.now() - t0;
    if (r.status !== 0) {
      throw new Error(`node single failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`);
    }
    samplesMs.push(ms);
  }
  return samplesMs;
}

/**
 * Spawns one node process per outer sample. Inside each process, the child
 * warms TurboFan with WARMUP repeats then measures MEASURED in-process
 * iterations. The child's reported per-iteration median is treated as one
 * outer-sample value. Returns per-outer-sample milliseconds.
 */
function timeNodeWarmIter(sourcePath, arg, outerRuns) {
  const cmdArgs = [CHILD_JS_PATH, "--mode=warm", sourcePath, String(arg)];
  const samplesMs = [];
  for (let i = 0; i < outerRuns; i++) {
    const r = spawnSync(process.execPath, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) {
      throw new Error(`node warm failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`);
    }
    const out = (r.stdout ?? "").toString().trim().split("\n").pop();
    const parsed = JSON.parse(out);
    if (typeof parsed?.medianMs !== "number") {
      throw new Error(`node warm did not return medianMs: ${out}`);
    }
    samplesMs.push(parsed.medianMs);
  }
  return samplesMs;
}

function buildRow({ programId, scenario, wasmSamplesUs, jsSamplesUs }) {
  const ratioSamples = wasmSamplesUs.map(
    (us, i) => (jsSamplesUs[i] ?? jsSamplesUs[jsSamplesUs.length - 1]) / Math.max(us, 0.000001),
  );
  const row = {
    name: programId,
    scenario,
    wasmUs: median(wasmSamplesUs),
    jsUs: median(jsSamplesUs),
    wasmStdUs: stddev(wasmSamplesUs),
    jsStdUs: stddev(jsSamplesUs),
    ratioStd: stddev(ratioSamples),
    warmupRounds: WARMUP_RUNS,
    measuredRounds: MEASURED_RUNS,
  };
  const javyMs = JAVY_NUMBERS_MS[programId]?.[scenario];
  if (typeof javyMs === "number" && javyMs > 0) {
    row.javyUs = javyMs * 1000;
  }
  const smMs = STARLINGMONKEY_NUMBERS_MS[programId]?.[scenario];
  if (typeof smMs === "number" && smMs > 0) {
    row.starlingMonkeyUs = smMs * 1000;
  }
  if (row.javyUs || row.starlingMonkeyUs) {
    row.lanesProvenance = LANES_PROVENANCE;
  }
  return row;
}

function writeOutput(rows) {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(rows, null, 2) + "\n");
  mkdirSync(dirname(PUBLIC_PATH), { recursive: true });
  copyFileSync(RESULTS_PATH, PUBLIC_PATH);
  console.log(`Updated ${RESULTS_PATH}`);
  console.log(`Updated ${PUBLIC_PATH}`);
}

async function main() {
  const version = ensureWasmtime();
  console.log(`Using ${version}`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const rows = [];

  for (const program of PROGRAMS) {
    process.stdout.write(`\n[${program.id}] compiling... `);
    const { sourcePath, wasmPath, warmWasmPath } = await compileProgram(program.id);
    const runtimeArg = readRuntimeArg(sourcePath);
    process.stdout.write(`runtimeArg=${runtimeArg}\n`);

    process.stdout.write(`[${program.id}] precompiling cranelift... `);
    const cwasmPath = precompile(wasmPath, program.id);
    const warmCwasmPath = precompile(warmWasmPath, `${program.id}-warm`);
    process.stdout.write(`ok\n`);

    // Cold path: full process wall time, no subtraction.
    process.stdout.write(`[${program.id}] wasm cold (full process)... `);
    const wasmColdMs = timeWasmtime(cwasmPath, runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(WARMUP_RUNS);
    process.stdout.write(`${median(wasmColdMs).toFixed(1)} ms\n`);

    process.stdout.write(`[${program.id}] v8 cold (full process)... `);
    const v8ColdMs = timeNodeColdProcess(sourcePath, runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(WARMUP_RUNS);
    process.stdout.write(`${median(v8ColdMs).toFixed(1)} ms\n`);

    // Warm path (#1760): in-process repeated-measure steady-state per-call
    // time, startup amortized. wasm via `warm` export (min per-call ms),
    // v8 via in-process iteration median — both startup-independent, so a
    // few-ms per-call codegen delta is now resolvable (the old cold−baseline
    // subtraction had a ~2.3× run-to-run spread that swamped the signal).
    process.stdout.write(`[${program.id}] wasm warm (in-process iter)... `);
    const wasmWarmMs = timeWasmtimeWarmIter(warmCwasmPath, runtimeArg, MEASURED_RUNS);
    process.stdout.write(`${median(wasmWarmMs).toFixed(2)} ms\n`);

    process.stdout.write(`[${program.id}] v8 warm (in-process iter)... `);
    const v8WarmMs = timeNodeWarmIter(sourcePath, runtimeArg, MEASURED_RUNS);
    process.stdout.write(`${median(v8WarmMs).toFixed(2)} ms\n`);

    const toUs = (samples) => samples.map((ms) => ms * 1000);

    rows.push(
      buildRow({
        programId: program.id,
        scenario: "cold",
        wasmSamplesUs: toUs(wasmColdMs),
        jsSamplesUs: toUs(v8ColdMs),
      }),
    );
    rows.push(
      buildRow({
        programId: program.id,
        scenario: "warm",
        wasmSamplesUs: toUs(wasmWarmMs),
        jsSamplesUs: toUs(v8WarmMs),
      }),
    );
  }

  writeOutput(rows);

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
