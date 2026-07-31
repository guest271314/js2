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

/** Which stage of {@link runStrategy} a failure came from. */
export type FailurePhase = "setup" | "warmup" | "calibration" | "mid-loop";

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
  /**
   * (#3904) Present and `"failed"` when the strategy errored instead of
   * producing timings. Timing fields are all `0` on such a row — every
   * consumer must skip them via {@link isMeasured}.
   *
   * A strategy listed in `BenchmarkDef.skip` is NOT recorded at all: an
   * absent row means "deliberately not applicable" and a `status: "failed"`
   * row means "this lane is broken". Before this existed, both looked
   * identical in `latest.json` (the row was simply missing), which is how the
   * four `dom/*` benchmarks shipped a JS-only chart for months.
   */
  status?: "failed";
  /** (#3904) First line of the error that made this strategy fail. */
  error?: string;
  /** (#3904) Stage the failure came from. */
  failedPhase?: FailurePhase;
}

/**
 * True when a row carries real timings. Failed rows are placeholders whose
 * numeric fields are all zero — never feed them to a median/ratio/winner
 * computation.
 */
export function isMeasured(r: BenchmarkResult): boolean {
  return r.status !== "failed";
}

export interface BenchmarkDef {
  name: string;
  /** TypeScript source exporting a `run` function (no args, returns void | number). */
  source: string;
  /** Number of timed iterations (default 100). */
  iterations?: number;
  /** Warmup iterations (default 5). */
  warmup?: number;
  /**
   * Host dependencies for buildImports (e.g. DOM stubs).
   *
   * This is the ONLY host-injection channel — every `env.*` import the module
   * declares is resolved from here. A `declared_global` import (`document`,
   * `window`, ...) is keyed by the *global's own name*, not by its class, so a
   * benchmark using `declare const document: Document` needs a `document`
   * entry, not just a `Document` one (#3904). A previous `extraEnv` field
   * claimed to inject extra env imports but was never read by the harness; it
   * was removed rather than left as a trap.
   */
  deps?: Record<string, unknown>;
  /** JS-equivalent function to benchmark as baseline. */
  js: () => void;
  /**
   * Strategies that are deliberately not applicable to this benchmark.
   * Skipped strategies produce no row at all; a strategy that *fails* produces
   * a `status: "failed"` row instead (#3904).
   */
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

/**
 * (#3904) Record a strategy failure as a first-class result row instead of
 * dropping it. The stderr line is kept for the interactive run; the returned
 * row is what makes the failure survive into `latest.json` so the published
 * page — and the next person reading it — can tell a broken lane from an
 * inapplicable one without re-running the suite by hand.
 */
function failedResult(name: string, strategy: Strategy, phase: FailurePhase, err: unknown): BenchmarkResult {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.split("\n")[0] ?? raw;
  // Preserve the historical stderr wording so existing greps keep matching.
  const phaseNote = phase === "setup" ? "" : phase === "warmup" ? " (runtime)" : ` (runtime, ${phase})`;
  process.stderr.write(`\n    [${strategy} skipped${phaseNote}: ${message}]\n`);
  return {
    name,
    strategy,
    iterations: 0,
    batchSize: 0,
    totalMs: 0,
    avgMs: 0,
    medianMs: 0,
    p95Ms: 0,
    status: "failed",
    error: message,
    failedPhase: phase,
  };
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

async function runStrategy(def: BenchmarkDef, strategy: Strategy): Promise<BenchmarkResult | null> {
  if (def.skip?.includes(strategy)) return null;

  const iterations = def.iterations ?? 100;
  const warmup = def.warmup ?? 5;
  const timings: number[] = [];

  let fn: () => void;
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
        fn = run as () => void;
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
        fn = run as () => void;
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
        fn = run as () => void;
        break;
      }
    }
  } catch (err) {
    // Strategy failed to compile / instantiate for this benchmark.
    // Some optimizer failures (notably Binaryen's Emscripten wrapper) set a
    // process exit code before throwing. Since this path downgrades the
    // failure to a recorded-but-unmeasured row, clear that sticky state here.
    process.exitCode = undefined;
    return failedResult(def.name, strategy, "setup", err);
  }

  // Warmup
  try {
    for (let i = 0; i < warmup; i++) fn();
  } catch (err) {
    return failedResult(def.name, strategy, "warmup", err);
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
    return failedResult(def.name, strategy, "calibration", err);
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
    return failedResult(def.name, strategy, "mid-loop", err);
  }

  timings.sort((a, b) => a - b);
  const totalMs = timings.reduce((s, t) => s + t, 0);

  return {
    name: def.name,
    strategy,
    iterations,
    batchSize,
    totalMs,
    avgMs: totalMs / iterations,
    medianMs: median(timings),
    p95Ms: percentile(timings, 95),
    binarySize,
    compileMs,
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
  for (const s of strategies) {
    const r = await runStrategy(def, s);
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
    const cols = results.map((r) =>
      isMeasured(r) ? `${r.strategy}: ${r.medianMs.toFixed(3)}ms` : `${r.strategy}: FAILED`,
    );
    console.log(` ${cols.join("  |  ")}`);
  }

  return all;
}
