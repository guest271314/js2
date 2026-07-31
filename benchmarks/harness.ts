/**
 * Benchmark harness for js2wasm.
 *
 * Compares four strategies:
 *   1. Pure JS          — run TypeScript source directly via eval
 *   2. Wasm host-call   — default mode (externref, host imports)
 *   3. Wasm GC-native   — fast mode (WasmGC structs/arrays, no host calls)
 *   4. Wasm linear      — fast + linear memory (future, skipped if unavailable)
 *
 * Usage:
 *   npx tsx benchmarks/run.ts [--suite strings|arrays|dom|mixed] [--filter name]
 */

import { compile, buildImports, instantiateWasm } from "../src/index.js";
import { calibrateBenchmarkBatchSize, timeBenchmarkBatch } from "./timing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Strategy = "js" | "host-call" | "gc-native" | "linear-memory";

export interface BenchmarkResult {
  name: string;
  strategy: Strategy;
  iterations: number;
  batchSize: number;
  totalMs: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  binarySize?: number;
  compileMs?: number;
  /** Primitive operations performed by one `run()` call, if the def declares it (#3898). */
  opsPerCall?: number;
  /** `medianMs` expressed per declared operation, in nanoseconds (#3898). */
  nsPerOp?: number;
  /** Floor `nsPerOp` was checked against (#3898). */
  minNsPerOp?: number;
  /**
   * Set by `report.ts` when `nsPerOp` is physically impossible — the lane is not
   * published as a valid comparison (#3898).
   */
  implausible?: boolean;
}

export interface BenchmarkDef {
  name: string;
  /** TypeScript source exporting a `run` function (no args, returns void | number). */
  source: string;
  /** Number of timed iterations (default 100). */
  iterations?: number;
  /** Warmup iterations (default 5). */
  warmup?: number;
  /** Host dependencies for buildImports (e.g. DOM stubs). */
  deps?: Record<string, unknown>;
  /** Extra env imports for manual instantiation. */
  extraEnv?: Record<string, Function>;
  /**
   * JS-equivalent function to benchmark as baseline.
   *
   * It SHOULD return an accumulator folding in every iteration (#3898): the
   * harness cross-checks that value against the Wasm `run()` return value, and
   * `report.ts` uses it to prove both lanes did the same work.
   */
  js: () => number | void;
  /**
   * Number of primitive operations one `run()` call performs (e.g. 1000
   * `indexOf` calls). Feeds the plausibility guard in `report.ts` (#3898):
   * a lane reporting under ~1 ns per operation is not measuring the work it
   * claims to measure and must not be published as a valid comparison.
   */
  opsPerCall?: number;
  /**
   * Benchmark-specific lower bound on the cost of one operation, in
   * nanoseconds, when more is known than the universal ~1 ns physical floor
   * (#3898).
   *
   * The universal floor alone would not have caught this bug: the hoisted
   * `string/indexOf` baseline reported 1.56 ns/op, which clears 1 ns. But an
   * `indexOf` that scans several characters and allocates nothing still cannot
   * retire in 1.56 ns, and the honest measurement is ~33 ns. Set this to a
   * value comfortably below the honest cost (roughly a quarter of it) so a
   * faster machine cannot trip it, while a collapsed loop — which is 20x+
   * faster, not 4x — always does.
   */
  minNsPerOp?: number;
  /** Strategies to skip for this benchmark. */
  skip?: Strategy[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------
// Compilation cache
// ---------------------------------------------------------------------------

interface CompiledModule {
  binary: Uint8Array;
  imports: any;
  stringPool: string[];
  compileMs: number;
}

const compileCache = new Map<string, CompiledModule>();

async function compileSource(source: string, fast: boolean, target?: "gc" | "linear"): Promise<CompiledModule> {
  const optimize = 4;
  const key = `${fast}:${target ?? "gc"}:O${optimize}:${source}`;
  const cached = compileCache.get(key);
  if (cached) return cached;

  const t0 = performance.now();
  const result = await compile(source, { fast, target, emitWat: false, optimize });
  const compileMs = performance.now() - t0;

  if (!result.success) {
    throw new Error(
      `Compilation failed (fast=${fast}, target=${target}):\n` + result.errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }

  const mod: CompiledModule = {
    binary: result.binary,
    imports: result.imports,
    stringPool: result.stringPool,
    compileMs,
  };
  compileCache.set(key, mod);
  return mod;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Cross-lane result assertion (#3898).
 *
 * The JS baseline and the Wasm `source` are supposed to be two implementations
 * of the *same* computation. If they disagree, whatever the page publishes as
 * "JS vs Wasm" is comparing two different workloads — which is exactly how the
 * hoisted string baselines went unnoticed for so long. Report it loudly and
 * drop the lane rather than publishing a meaningless ratio.
 */
function assertSameResult(name: string, strategy: Strategy, jsResult: unknown, wasmResult: unknown): boolean {
  if (typeof jsResult !== "number" || typeof wasmResult !== "number") return true;
  if (Object.is(jsResult, wasmResult)) return true;

  process.stderr.write(
    `\n` +
      `  !! CROSS-LANE MISMATCH in "${name}" [${strategy}]\n` +
      `     js baseline returned ${jsResult}, wasm run() returned ${wasmResult}.\n` +
      `     The two lanes are not computing the same thing; refusing to publish\n` +
      `     this comparison (#3898).\n`,
  );
  process.exitCode = 1;
  return false;
}

async function runStrategy(
  def: BenchmarkDef,
  strategy: Strategy,
  jsReference: unknown,
): Promise<BenchmarkResult | null> {
  if (def.skip?.includes(strategy)) return null;

  const iterations = def.iterations ?? 100;
  const warmup = def.warmup ?? 5;
  const timings: number[] = [];

  let fn: () => unknown;
  let binarySize: number | undefined;
  let compileMs: number | undefined;

  try {
    switch (strategy) {
      case "js": {
        fn = def.js;
        break;
      }

      case "host-call": {
        const mod = await compileSource(def.source, false);
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        imports.setInstance?.(instance);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in host-call module for "${def.name}"`);
        fn = run as () => unknown;
        break;
      }

      case "gc-native": {
        const mod = await compileSource(def.source, true);
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        imports.setInstance?.(instance);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in gc-native module for "${def.name}"`);
        fn = run as () => unknown;
        break;
      }

      case "linear-memory": {
        const mod = await compileSource(def.source, true, "linear");
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        imports.setInstance?.(instance);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in linear-memory module for "${def.name}"`);
        fn = run as () => unknown;
        break;
      }
    }
  } catch (err) {
    // Strategy not supported for this benchmark
    // Some optimizer failures (notably Binaryen's Emscripten wrapper) set a
    // process exit code before throwing. Since this path explicitly treats the
    // strategy as skipped, clear that sticky failure state here.
    process.exitCode = undefined;
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n    [${strategy} skipped: ${msg.split("\n")[0]}]\n`);
    return null;
  }

  // Warmup
  let lastResult: unknown;
  try {
    for (let i = 0; i < warmup; i++) lastResult = fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n    [${strategy} skipped (runtime): ${msg.split("\n")[0]}]\n`);
    return null;
  }

  // Cross-lane result assertion (#3898) — after warmup, before timing.
  if (strategy !== "js" && !assertSameResult(def.name, strategy, jsReference, lastResult)) {
    return null;
  }

  // Linear-memory benchmarks may use a bump allocator whose state persists
  // between calls, so retain their historical single-call samples. Other
  // strategies are safe to batch: the harness already invokes each function
  // repeatedly and observes timing rather than individual return values.
  let batchSize = 1;
  try {
    if (strategy !== "linear-memory") {
      batchSize = calibrateBenchmarkBatchSize(fn);
      timeBenchmarkBatch(fn, batchSize); // warm the calibrated loop before retaining samples
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n    [${strategy} skipped (runtime, calibration): ${msg.split("\n")[0]}]\n`);
    return null;
  }

  // Timed runs. Each entry is normalized to one benchmark call, preserving the
  // existing result units while avoiding sub-millisecond timer quantization.
  //
  // Guard the same way as warmup (#1868): a strategy can pass warmup yet trap
  // mid-loop — e.g. the linear-memory backend's bump allocator exhausts memory
  // after many `split`/concat iterations, surfacing as a `memory access out of
  // bounds` RuntimeError. Whether that trap lands in warmup (caught) or in a
  // later timed iteration is non-deterministic across V8 versions, so an
  // unguarded timed loop made the whole benchmark suite abort fatally on CI
  // (Node 26) while passing locally (Node 25). Catching it here downgrades a
  // mid-run trap to a skipped strategy, matching warmup's behaviour.
  try {
    for (let i = 0; i < iterations; i++) {
      timings.push(timeBenchmarkBatch(fn, batchSize) / batchSize);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n    [${strategy} skipped (runtime, mid-loop): ${msg.split("\n")[0]}]\n`);
    return null;
  }

  timings.sort((a, b) => a - b);
  const totalMs = timings.reduce((s, t) => s + t, 0);
  const medianMs = median(timings);

  return {
    name: def.name,
    strategy,
    iterations,
    batchSize,
    totalMs,
    avgMs: totalMs / iterations,
    medianMs,
    p95Ms: percentile(timings, 95),
    binarySize,
    compileMs,
    opsPerCall: def.opsPerCall,
    nsPerOp: def.opsPerCall ? (medianMs * 1e6) / def.opsPerCall : undefined,
    minNsPerOp: def.minNsPerOp,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ALL_STRATEGIES: Strategy[] = ["js", "host-call", "gc-native", "linear-memory"];

export async function runBenchmark(
  def: BenchmarkDef,
  strategies: Strategy[] = ALL_STRATEGIES,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Reference value for the cross-lane assertion (#3898). Computed once, outside
  // the timed region, so a throwing baseline cannot abort the whole suite.
  let jsReference: unknown;
  try {
    jsReference = def.js();
  } catch {
    jsReference = undefined;
  }

  for (const s of strategies) {
    const r = await runStrategy(def, s, jsReference);
    if (r) results.push(r);
  }
  return results;
}

export async function runSuite(
  name: string,
  defs: BenchmarkDef[],
  strategies: Strategy[] = ALL_STRATEGIES,
): Promise<BenchmarkResult[]> {
  console.log(`\n=== Suite: ${name} ===\n`);
  const all: BenchmarkResult[] = [];

  for (const def of defs) {
    process.stdout.write(`  ${def.name} ...`);
    const results = await runBenchmark(def, strategies);
    all.push(...results);

    // Inline summary
    const cols = results.map((r) => `${r.strategy}: ${r.medianMs.toFixed(3)}ms`);
    console.log(` ${cols.join("  |  ")}`);
  }

  return all;
}
