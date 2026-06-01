#!/usr/bin/env node
/**
 * Generates the Wasmtime-vs-V8 per-request comparison data for the landing
 * page chart `<perf-benchmark-chart src="…hot-runtime.json">`.
 *
 * The page positions this as a generic edge-serverless comparison between
 * two production runtime architectures: an AOT-compiled Wasm edge runtime
 * vs a V8-isolate edge runtime. Both run untrusted code per request, but
 * with very different cost models for fresh-vs-reused execution contexts. No
 * specific commercial platform is named — the lanes describe the
 * *architecture/scenario*, not a product.
 *
 * Two scenarios per program (8 rows total):
 *
 *   1. **Per-request cold (warm engine, fresh context/instance)**
 *      Models the representative edge-serverless cold request: the engine is
 *      already resident in a long-lived host process, and the request pays
 *      only for its own execution context / instance plus the first call.
 *      - JS lane (#1764): primary `jsUs` is a dependency-free lower bound:
 *        one long-lived Node/V8 process, and per measured request:
 *        `vm.createContext()`, `new vm.Script(program)`, and
 *        `script.runInContext(ctx)` for the first `run(arg)`. A Node `vm`
 *        Context is lighter than a true V8 isolate because it shares the
 *        host isolate's heap and built-ins, so it under-counts the real
 *        isolate-per-request allocation. The JSON also records
 *        `jsCompiledContextUs`, a compiled-once / new-context-per-request
 *        sensitivity number. A fresh `worker_threads` Worker would be the
 *        heavier upper-bound analog (own thread/event loop/heap), but this
 *        generator does not emit that row by default to keep refreshes cheap.
 *      - Wasm lane (#1764): primary `wasmUs` comes from the committed Rust
 *        host in `benchmarks/wasmtime-cold-host`. The host owns a warm
 *        Wasmtime `Engine` plus a Cranelift-compiled `Module`; per measured
 *        request it creates a fresh `Store` + `Instance` and calls
 *        `run(arg)` once. This intentionally removes OS-process startup and
 *        uses Wasmtime/Cranelift, not Node's host WebAssembly engine. The
 *        `wasmtime run` CLI cannot model pooling because every CLI
 *        invocation starts a fresh process, so the generator builds and
 *        shells out to this embedding host for the cold lane.
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
 * Requirements: Rust/Cargo for the cold Wasmtime embedding host; `wasmtime`
 * (v35+) on PATH for the warm steady-state Wasmtime lane; Node.js for the
 * JS/V8 lanes and compiler bundle; competitive programs under
 * `website/public/benchmarks/competitive/programs/*.js`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Script, createContext } from "node:vm";
import { compile } from "./compiler-bundle.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PROGRAMS_DIR = resolve(ROOT, "website", "public", "benchmarks", "competitive", "programs");
const ARTIFACT_DIR = resolve(ROOT, ".tmp", "wasmtime-hot-runtime");
const CHILD_JS_PATH = resolve(import.meta.dirname, "wasmtime-bench-child-js.mjs");
const WASM_OPT_PATH = resolve(ROOT, "node_modules", ".bin", "wasm-opt");
const WASMTIME_COLD_HOST_DIR = resolve(ROOT, "benchmarks", "wasmtime-cold-host");
const WASMTIME_COLD_HOST_MANIFEST = resolve(WASMTIME_COLD_HOST_DIR, "Cargo.toml");
const WASMTIME_COLD_HOST_TARGET_DIR = resolve(WASMTIME_COLD_HOST_DIR, "target");
const WASMTIME_COLD_HOST_BIN = resolve(
  WASMTIME_COLD_HOST_TARGET_DIR,
  "release",
  process.platform === "win32" ? "wasmtime-cold-host.exe" : "wasmtime-cold-host",
);

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

// Javy + StarlingMonkey verified warm numbers (2026-04-27 wasmtime 44.0.0,
// aarch64-linux) — see labs benchmarks/compare-runtimes.ts.
// Map: `warm` → README "Compute-only ms" (steady-state per call).
// The old `cold` values from that harness were full-process startup numbers;
// #1764 intentionally omits them from the warm-engine cold row until those
// lanes have matching context/instance-per-request measurements.
// Programs not present in either table fall back to 0 (omitted from chart).
const JAVY_NUMBERS_MS = {
  fib: { warm: 1193.2 },
  "fib-recursive": { warm: 87.9 },
  "array-sum": { warm: 112.9 },
  "string-hash": { warm: 36.0 },
};
const STARLINGMONKEY_NUMBERS_MS = {
  fib: { warm: 1024.3 },
  "fib-recursive": { warm: 156.7 },
  "array-sum": { warm: 125.5 },
  "string-hash": { warm: 14.2 },
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

function min(values) {
  return values.length === 0 ? 0 : Math.min(...values);
}

function max(values) {
  return values.length === 0 ? 0 : Math.max(...values);
}

function ensureWasmtime() {
  try {
    const out = execFileSync("wasmtime", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return out.toString().trim();
  } catch {
    throw new Error("wasmtime not found on PATH. Install from https://wasmtime.dev/ and retry.");
  }
}

function ensureWasmtimeColdHost() {
  try {
    execFileSync("cargo", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("cargo not found on PATH. Install Rust/Cargo to build benchmarks/wasmtime-cold-host.");
  }

  execFileSync("cargo", ["build", "--release", "--manifest-path", WASMTIME_COLD_HOST_MANIFEST], {
    env: { ...process.env, CARGO_TARGET_DIR: WASMTIME_COLD_HOST_TARGET_DIR },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return WASMTIME_COLD_HOST_BIN;
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

  const wasmtimeWasmPath = normalizeWasmForWasmtime(wasmPath, id);
  const wasmtimeWarmWasmPath = normalizeWasmForWasmtime(warmWasmPath, `${id}-warm`);

  return { sourcePath, wasmPath: wasmtimeWasmPath, warmWasmPath: wasmtimeWarmWasmPath };
}

function precompile(wasmPath, label) {
  const cwasmPath = resolve(ARTIFACT_DIR, `${label}.cranelift.cwasm`);
  const args = ["compile", ...WASMTIME_FEATURES, wasmPath, "-o", cwasmPath];
  execFileSync("wasmtime", args, { stdio: ["ignore", "pipe", "pipe"] });
  return cwasmPath;
}

function normalizeWasmForWasmtime(wasmPath, label) {
  const normalizedPath = resolve(ARTIFACT_DIR, `${label}.wasmtime.wasm`);
  try {
    execFileSync(
      WASM_OPT_PATH,
      ["--all-features", "--disable-custom-descriptors", "-O3", wasmPath, "-o", normalizedPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return normalizedPath;
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr).slice(0, 400) : String(err);
    console.warn(`[${label}] wasm-opt normalization skipped; wasmtime may reject exact refs: ${stderr}`);
    return wasmPath;
  }
}

function readRuntimeArg(sourcePath) {
  const text = readFileSync(sourcePath, "utf8");
  const match = text.match(/runtimeArg:\s*(\d+)/);
  if (!match) throw new Error(`runtimeArg not found in ${sourcePath}`);
  return Number(match[1]);
}

function makeVmScriptSource(sourcePath) {
  const source = readFileSync(sourcePath, "utf8");
  const programBody = source
    .replace(/export const benchmark[\s\S]*?};\n/, "")
    .replace(/\bexport\s+function\s+run\b/, "function run");
  return `${programBody}\nrun(globalThis.__runtimeArg__);\n`;
}

/**
 * #1764: cold JS lower-bound lane. One long-lived Node/V8 process, and per
 * measured request: allocate a fresh vm Context, compile the program into a
 * Script, and run `run(arg)` once in that context. This avoids process
 * startup and captures context + compile + first-run cost against a warm V8.
 * A vm Context is lighter than a true isolate, so this is a lower bound.
 */
function timeNodeVmContextFreshCompile(sourcePath, arg, runs) {
  const scriptSource = makeVmScriptSource(sourcePath);
  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const context = createContext({ __runtimeArg__: arg });
    const script = new Script(scriptSource, { filename: sourcePath });
    const result = script.runInContext(context);
    const ms = performance.now() - t0;
    void result;
    samplesMs.push(ms);
  }
  return samplesMs;
}

/**
 * #1764 sensitivity number: compile the Script once in the long-lived host,
 * then allocate a fresh vm Context per request and run once. This approximates
 * an embedder with an already-parsed code cache.
 */
function timeNodeVmContextCompiledOnce(sourcePath, arg, runs) {
  const script = new Script(makeVmScriptSource(sourcePath), { filename: sourcePath });
  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const context = createContext({ __runtimeArg__: arg });
    const result = script.runInContext(context);
    const ms = performance.now() - t0;
    void result;
    samplesMs.push(ms);
  }
  return samplesMs;
}

/**
 * #1764: cold Wasmtime instantiate lane. Spawns the Rust embedding host once
 * per program. Inside that process, Wasmtime owns a warm Engine plus compiled
 * Module, and each measured request allocates a fresh Store + Instance and
 * calls run(arg) once. The returned samples therefore exclude OS-process
 * startup and measure Wasmtime/Cranelift instantiation, not Node WebAssembly.
 */
function timeWasmtimeFreshInstance(hostPath, wasmPath, arg, runs) {
  const r = spawnSync(hostPath, [wasmPath, String(arg), String(runs)], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(`wasmtime cold host failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 800)}`);
  }
  const out = (r.stdout ?? "").toString().trim().split("\n").pop();
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed?.samplesMs) || parsed.samplesMs.length !== runs) {
    throw new Error(`wasmtime cold host did not return ${runs} samples: ${out}`);
  }
  for (const sample of parsed.samplesMs) {
    if (typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0) {
      throw new Error(`wasmtime cold host returned invalid sample: ${out}`);
    }
  }
  return parsed.samplesMs;
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

function buildRow({ programId, scenario, wasmSamplesUs, jsSamplesUs, extra = {} }) {
  const ratioSamples = wasmSamplesUs.map(
    (us, i) => (jsSamplesUs[i] ?? jsSamplesUs[jsSamplesUs.length - 1]) / Math.max(us, 0.000001),
  );
  const row = {
    name: programId,
    scenario,
    wasmUs: median(wasmSamplesUs),
    jsUs: median(jsSamplesUs),
    wasmMinUs: min(wasmSamplesUs),
    wasmMaxUs: max(wasmSamplesUs),
    jsMinUs: min(jsSamplesUs),
    jsMaxUs: max(jsSamplesUs),
    wasmStdUs: stddev(wasmSamplesUs),
    jsStdUs: stddev(jsSamplesUs),
    ratioStd: stddev(ratioSamples),
    warmupRounds: WARMUP_RUNS,
    measuredRounds: MEASURED_RUNS,
    ...extra,
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
  process.stdout.write("Building Rust wasmtime cold host... ");
  const coldHostPath = ensureWasmtimeColdHost();
  process.stdout.write(`ok (${coldHostPath})\n`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const rows = [];

  for (const program of PROGRAMS) {
    process.stdout.write(`\n[${program.id}] compiling... `);
    const { sourcePath, wasmPath, warmWasmPath } = await compileProgram(program.id);
    const runtimeArg = readRuntimeArg(sourcePath);
    process.stdout.write(`runtimeArg=${runtimeArg}\n`);

    process.stdout.write(`[${program.id}] precompiling warm cranelift... `);
    const warmCwasmPath = precompile(warmWasmPath, `${program.id}-warm`);
    process.stdout.write(`ok\n`);

    // Cold path (#1764): warm engine / fresh context-or-instance per request,
    // no OS-process startup in the measured samples.
    process.stdout.write(`[${program.id}] wasm cold (wasmtime fresh store+instance)... `);
    const wasmColdMs = timeWasmtimeFreshInstance(coldHostPath, wasmPath, runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(
      WARMUP_RUNS,
    );
    process.stdout.write(`${median(wasmColdMs).toFixed(3)} ms\n`);

    process.stdout.write(`[${program.id}] v8 cold (vm context + fresh compile)... `);
    const v8ColdMs = timeNodeVmContextFreshCompile(sourcePath, runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(
      WARMUP_RUNS,
    );
    process.stdout.write(`${median(v8ColdMs).toFixed(3)} ms\n`);

    process.stdout.write(`[${program.id}] v8 cold sensitivity (vm context + compiled script)... `);
    const v8CompiledContextMs = timeNodeVmContextCompiledOnce(
      sourcePath,
      runtimeArg,
      WARMUP_RUNS + MEASURED_RUNS,
    ).slice(WARMUP_RUNS);
    process.stdout.write(`${median(v8CompiledContextMs).toFixed(3)} ms\n`);

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
        extra: {
          wasmColdMode: "rust-wasmtime-compile-once-fresh-store-instance",
          wasmColdEngine: "wasmtime-cranelift",
          wasmColdHost: "benchmarks/wasmtime-cold-host",
          jsColdMode: "node-vm-create-context-fresh-script",
          jsColdFidelity: "vm-context-lower-bound-vs-true-v8-isolate",
          jsCompiledContextUs: median(toUs(v8CompiledContextMs)),
          jsCompiledContextStdUs: stddev(toUs(v8CompiledContextMs)),
        },
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
