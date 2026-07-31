// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3898 — the perf-page string benchmarks measured V8's loop-invariant code
// motion, not string performance.
//
// The published `benchmarks/results/latest.json` reported JS baselines that were
// physically impossible (1.56 ns for an `indexOf` over a 10,000-char haystack,
// 0.13 ns for a `toLowerCase`), because every one of those loops called a pure
// `String.prototype` method with a constant receiver and constant arguments.
// TurboFan hoisted the call out of the loop and ran it once, so the page
// compared "V8 ran it once" against "js2wasm ran it 1000 times".
//
// These tests lock in the two guards that would have caught it:
//   1. a plausibility floor on the implied per-operation cost, and
//   2. a cross-lane assertion that the JS baseline and the Wasm `source` compute
//      the same value.

import { describe, it, expect } from "vitest";
import { compile, buildImports, instantiateWasm } from "../src/index.js";
import { stringBenchmarks } from "../benchmarks/suites/strings.js";
import { mixedBenchmarks } from "../benchmarks/suites/mixed.js";
import { flagImplausibleLanes, MIN_PLAUSIBLE_NS_PER_OP } from "../benchmarks/report.js";
import type { BenchmarkResult } from "../benchmarks/harness.js";

function lane(over: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    name: "x",
    strategy: "js",
    iterations: 1,
    batchSize: 1,
    totalMs: 0,
    avgMs: 0,
    medianMs: 0,
    p95Ms: 0,
    ...over,
  };
}

describe("#3898 plausibility guard", () => {
  it("flags the historical impossible string/indexOf JS baseline", () => {
    // The 2026-07-31 published run: 0.0015575 ms for 1000 indexOf calls.
    //
    // 1.5575 ns/op clears the universal 1 ns floor, which is exactly why the
    // per-benchmark `minNsPerOp` exists — an `indexOf` that scans several
    // characters honestly costs ~33 ns here.
    const results = [lane({ name: "string/indexOf", medianMs: 0.0015575, opsPerCall: 1000, minNsPerOp: 5 })];
    const flagged = flagImplausibleLanes(results);

    expect(flagged).toHaveLength(1);
    expect(results[0]!.implausible).toBe(true);
    expect(results[0]!.nsPerOp).toBeCloseTo(1.5575, 3);
  });

  it("the universal floor alone would have missed string/indexOf", () => {
    // Documents why `minNsPerOp` is load-bearing rather than belt-and-braces.
    const results = [lane({ name: "string/indexOf", medianMs: 0.0015575, opsPerCall: 1000 })];
    expect(flagImplausibleLanes(results)).toHaveLength(0);
    expect(results[0]!.nsPerOp!).toBeGreaterThan(MIN_PLAUSIBLE_NS_PER_OP);
  });

  it("flags the historical impossible string/case-convert JS baseline", () => {
    // 0.00025358 ms for 2000 case conversions → 0.13 ns per conversion.
    const results = [lane({ name: "string/case-convert", medianMs: 0.00025358, opsPerCall: 2000 })];
    flagImplausibleLanes(results);

    expect(results[0]!.implausible).toBe(true);
    expect(results[0]!.nsPerOp!).toBeLessThan(MIN_PLAUSIBLE_NS_PER_OP);
  });

  it("leaves a plausible lane alone and clears a stale flag", () => {
    // 29 ns per indexOf — the honest cost measured with a varying argument.
    const results = [
      lane({ name: "string/indexOf", medianMs: 0.029, opsPerCall: 1000, minNsPerOp: 5, implausible: true }),
    ];
    const flagged = flagImplausibleLanes(results);

    expect(flagged).toHaveLength(0);
    expect(results[0]!.implausible).toBeUndefined();
    expect(results[0]!.nsPerOp).toBeCloseTo(29, 6);
  });

  it("skips lanes that do not declare an operation count", () => {
    const results = [lane({ name: "dom/create-elements", medianMs: 0.0000001 })];
    expect(flagImplausibleLanes(results)).toHaveLength(0);
    expect(results[0]!.implausible).toBeUndefined();
  });
});

describe("#3898 benchmark definitions", () => {
  const defs = [...stringBenchmarks, ...mixedBenchmarks];

  it("every string and mixed benchmark declares opsPerCall", () => {
    const missing = defs.filter((d) => !d.opsPerCall).map((d) => d.name);
    expect(missing).toEqual([]);
  });

  it("every JS baseline returns a finite accumulator", () => {
    for (const def of defs) {
      const value = def.js();
      expect(typeof value, `${def.name} must return its accumulator`).toBe("number");
      expect(Number.isFinite(value as number), `${def.name} returned ${value}`).toBe(true);
    }
  });

  it("no JS baseline is fast enough to be impossible", () => {
    // A direct, allocation-free re-derivation of the original bug report: time
    // each baseline and check the implied per-op cost clears the floor. Loose
    // bounds only — this asserts "the loop did not collapse", not a perf target.
    for (const def of defs) {
      for (let i = 0; i < 3; i++) def.js(); // warm up / let TurboFan settle

      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        def.js();
        best = Math.min(best, performance.now() - t0);
      }

      const nsPerOp = (best * 1e6) / def.opsPerCall!;
      const floor = Math.max(MIN_PLAUSIBLE_NS_PER_OP, def.minNsPerOp ?? 0);
      expect(nsPerOp, `${def.name}: ${nsPerOp.toFixed(3)} ns/op — loop looks hoisted`).toBeGreaterThanOrEqual(floor);
    }
  }, 60_000);
});

describe("#3898 cross-lane equivalence", () => {
  // The assertion the harness now performs on every run, exercised here on the
  // benchmarks the issue named as invalid so a divergence fails CI, not the
  // public page.
  const named = ["string/indexOf", "string/includes", "string/substring", "string/case-convert"];

  it.each(named)(
    "%s: wasm run() matches the JS baseline",
    async (name) => {
      const def = stringBenchmarks.find((d) => d.name === name)!;
      expect(def).toBeDefined();

      const result = await compile(def.source, { fast: true, emitWat: false });
      expect(result.success, `compile failed: ${result.errors?.[0]?.message}`).toBe(true);

      const imports = buildImports(result.imports, {}, result.stringPool);
      const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
      imports.setInstance?.(instance);

      const run = (instance.exports as Record<string, Function>).run!;
      expect(run()).toBe(def.js());
    },
    120_000,
  );
});
