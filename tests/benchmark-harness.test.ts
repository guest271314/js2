// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { BENCHMARK_MAX_BATCH_SIZE, BENCHMARK_SAMPLE_TARGET_MS, nextBenchmarkBatchSize } from "../benchmarks/timing.js";

describe("internal benchmark batching", () => {
  it("scales sub-millisecond calls to a scheduler-sized sample", () => {
    expect(nextBenchmarkBatchSize(0.01, 1)).toBe(500);
    expect(nextBenchmarkBatchSize(BENCHMARK_SAMPLE_TARGET_MS, 500)).toBe(500);
  });

  it("makes progress for zero-duration probes and clamps pathological batches", () => {
    expect(nextBenchmarkBatchSize(0, 1)).toBe(2);
    expect(nextBenchmarkBatchSize(0.000001, 1)).toBe(BENCHMARK_MAX_BATCH_SIZE);
    expect(nextBenchmarkBatchSize(1, BENCHMARK_MAX_BATCH_SIZE)).toBe(BENCHMARK_MAX_BATCH_SIZE);
  });
});
