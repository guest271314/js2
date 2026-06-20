import { describe, it, expect } from "vitest";
import {
  REGRESSION_RATIO_LIMIT,
  REGRESSION_BUCKET_LIMIT,
  REGRESSION_BUCKET_PATH_DEPTH,
  RATIO_WAIVE_MAX_REGRESSIONS,
  bucketRegressions,
  evaluateRegressionThresholds,
} from "../scripts/diff-test262.js";

// #1943 — the documented merge thresholds (10% regression ratio, 50-per-bucket)
// must be ENFORCED by the regression gate, not just documented in the
// dev-self-merge skill text. These unit tests pin the pure gate logic so the
// constants and the bucket grouping stay byte-identical to the skill.
describe("#1943 — regression threshold enforcement", () => {
  it("exposes the documented constants", () => {
    expect(REGRESSION_RATIO_LIMIT).toBe(0.1);
    expect(REGRESSION_BUCKET_LIMIT).toBe(50);
    expect(REGRESSION_BUCKET_PATH_DEPTH).toBe(5);
  });

  it("buckets regressions by the first 5 path segments (skill-identical)", () => {
    const buckets = bucketRegressions([
      "test/built-ins/Array/prototype/every/a.js",
      "test/built-ins/Array/prototype/every/b.js",
      "test/built-ins/Array/prototype/some/c.js",
    ]);
    expect(buckets[0]).toEqual({ bucket: "test/built-ins/Array/prototype/every", count: 2 });
    expect(buckets.find((b) => b.bucket === "test/built-ins/Array/prototype/some")?.count).toBe(1);
  });

  it("FAILS a 10-improvement / 5-regression diff (ratio 50%)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 10,
      regressionsWasmChange: 5,
      regressedFiles: Array.from({ length: 5 }, (_, i) => `test/built-ins/Reg${i}/x/y/t.js`),
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.includes("ratio") && f.includes("50.0%"))).toBe(true);
  });

  it("FAILS a 60-in-one-bucket diff even when the ratio is under 10%", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 700, // 60/700 = 8.6% < 10% → ratio OK
      regressionsWasmChange: 60,
      regressedFiles: Array.from({ length: 60 }, (_, i) => `test/built-ins/Array/prototype/every/case${i}.js`),
    });
    expect(failures.some((f) => f.includes("bucket") && f.includes("every") && f.includes("60"))).toBe(true);
    expect(failures.some((f) => f.includes("ratio"))).toBe(false);
  });

  it("PASSES a clean diff (no regressions, few improvements)", () => {
    expect(evaluateRegressionThresholds({ improvements: 2, regressionsWasmChange: 0, regressedFiles: [] })).toEqual([]);
  });

  it("PASSES a borderline 9% ratio (under the 10% limit)", () => {
    expect(
      evaluateRegressionThresholds({
        improvements: 100,
        regressionsWasmChange: 9,
        regressedFiles: Array.from({ length: 9 }, (_, i) => `test/reg${i}/x/y/z/t.js`),
      }),
    ).toEqual([]);
  });

  it("FAILS when regressions exist but there are zero improvements (∞ ratio)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 0,
      regressionsWasmChange: 3,
      regressedFiles: ["test/a/b/c/d/e.js", "test/a/b/c/d/f.js", "test/g/h/i/j/k.js"],
    });
    expect(failures.some((f) => f.includes("ratio") && f.includes("∞"))).toBe(true);
  });
});

// #2562 — src-aware ratio waiver. When the baseline is CONTENT-current (0
// test262-relevant commits behind main HEAD, even if clock-stale during a
// docs/CI-only merge stretch), a tiny net-positive drift/flake regression must
// NOT trip the 10% ratio gate. But the waiver is tightly bounded: it never
// touches the bucket gate or the net<0 gate, and only fires for net-positive
// diffs with ≤RATIO_WAIVE_MAX_REGRESSIONS absolute regressions.
describe("#2562 — src-aware ratio waiver", () => {
  it("exposes the waiver bound constant", () => {
    expect(RATIO_WAIVE_MAX_REGRESSIONS).toBe(3);
  });

  it("WAIVES the ratio gate for the exact over-reaction case (1 regression / 9 improvements, 11.1% ≥ 10%) when content-current", () => {
    // This is the precise scenario that failed PRs #1742/#1711 on 2026-06-20.
    const failures = evaluateRegressionThresholds({
      improvements: 9,
      regressionsWasmChange: 1,
      regressedFiles: ["test/built-ins/Reg0/x/y/t.js"],
      baselineContentCurrent: true,
    });
    expect(failures).toEqual([]);
  });

  it("STILL FAILS the same 1/9 case when the baseline is NOT content-current (default)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 9,
      regressionsWasmChange: 1,
      regressedFiles: ["test/built-ins/Reg0/x/y/t.js"],
      // baselineContentCurrent omitted → false → strict gate
    });
    expect(failures.some((f) => f.includes("ratio") && f.includes("11.1%"))).toBe(true);
  });

  it("does NOT waive when the absolute regression count exceeds the bound, even if content-current", () => {
    // 4 regressions > RATIO_WAIVE_MAX_REGRESSIONS (3): the magnitude is too
    // large to be dismissed as drift/flake, so the ratio gate still fires.
    const failures = evaluateRegressionThresholds({
      improvements: 9,
      regressionsWasmChange: 4,
      regressedFiles: Array.from({ length: 4 }, (_, i) => `test/built-ins/Reg${i}/x/y/t.js`),
      baselineContentCurrent: true,
    });
    expect(failures.some((f) => f.includes("ratio"))).toBe(true);
  });

  it("does NOT waive when the diff is net-NEGATIVE, even if content-current and within the count bound", () => {
    // 3 regressions, 2 improvements: net-negative. The waiver requires
    // net-positive, so the ratio gate still fires (and the net<0 gate, enforced
    // by the caller, would too).
    const failures = evaluateRegressionThresholds({
      improvements: 2,
      regressionsWasmChange: 3,
      regressedFiles: ["test/a/b/c/d/e.js", "test/a/b/c/d/f.js", "test/g/h/i/j/k.js"],
      baselineContentCurrent: true,
    });
    expect(failures.some((f) => f.includes("ratio"))).toBe(true);
  });

  it("STILL enforces the bucket gate even when content-current (a real cluster cannot slip through)", () => {
    // 60 regressions all in one bucket, but improvements huge so the waiver's
    // count bound (≤3) is already exceeded; the bucket gate fires regardless.
    const failures = evaluateRegressionThresholds({
      improvements: 700,
      regressionsWasmChange: 60,
      regressedFiles: Array.from({ length: 60 }, (_, i) => `test/built-ins/Array/prototype/every/case${i}.js`),
      baselineContentCurrent: true,
    });
    expect(failures.some((f) => f.includes("bucket") && f.includes("every") && f.includes("60"))).toBe(true);
  });

  it("waives at the exact bound (3 regressions, net-positive, content-current)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 10,
      regressionsWasmChange: 3,
      regressedFiles: ["test/a/b/c/d/e.js", "test/f/g/h/i/j.js", "test/k/l/m/n/o.js"],
      baselineContentCurrent: true,
    });
    expect(failures).toEqual([]);
  });
});
