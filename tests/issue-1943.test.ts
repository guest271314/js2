import { describe, it, expect } from "vitest";
import {
  REGRESSION_RATIO_LIMIT,
  REGRESSION_BUCKET_LIMIT,
  REGRESSION_BUCKET_PATH_DEPTH,
  RATIO_MIN_ABSOLUTE_REGRESSIONS,
  RATIO_FLOOR_CONTENT_CURRENT_BONUS,
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

// #2562 — absolute regression-count FLOOR for the ratio gate. A net-positive PR
// must not fail the 10% ratio gate on 1–2 residual drift/flake regressions
// against few improvements (the exact #1742/#1711 over-reaction: Net +8, 1
// regression on a single nondeterministic file, recorded `pass` in a
// freshly-refreshed baseline). The floor is UNCONDITIONAL (does NOT require the
// baseline to be provably content-current — the observed blocker is flake, not
// stale content); the content-current signal only WIDENS it. The bucket gate
// and the caller's net<0 gate are never affected.
describe("#2562 — ratio-gate absolute regression floor", () => {
  it("exposes the floor constants", () => {
    expect(RATIO_MIN_ABSOLUTE_REGRESSIONS).toBe(3);
    expect(RATIO_FLOOR_CONTENT_CURRENT_BONUS).toBe(2);
  });

  it("FLOORS the exact over-reaction case (1 regression / 9 improvements, 11.1% ≥ 10%) UNCONDITIONALLY — no content-current flag needed", () => {
    // The precise scenario that failed PRs #1742/#1711 on 2026-06-20. The
    // blocker was a flake against a fresh baseline, so the floor must apply
    // WITHOUT the content-current signal.
    const failures = evaluateRegressionThresholds({
      improvements: 9,
      regressionsWasmChange: 1,
      regressedFiles: ["test/built-ins/Reg0/x/y/t.js"],
      // baselineContentCurrent omitted → floor still applies (1 < 3).
    });
    expect(failures).toEqual([]);
  });

  it("FLOORS 2 regressions / 9 improvements (net-positive, below the unconditional floor)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 9,
      regressionsWasmChange: 2,
      regressedFiles: ["test/a/b/c/d/e.js", "test/f/g/h/i/j.js"],
    });
    expect(failures).toEqual([]);
  });

  it("FAILS at the floor — 3 genuine regressions / 9 improvements re-engages the ratio gate (real regression)", () => {
    // 3 == RATIO_MIN_ABSOLUTE_REGRESSIONS, so the ratio gate fires: ≥3 genuine
    // regressions against few improvements is a real regression, not flake.
    const failures = evaluateRegressionThresholds({
      improvements: 9,
      regressionsWasmChange: 3,
      regressedFiles: ["test/a/b/c/d/e.js", "test/f/g/h/i/j.js", "test/k/l/m/n/o.js"],
    });
    expect(failures.some((f) => f.includes("ratio") && f.includes("33.3%"))).toBe(true);
  });

  it("does NOT floor a net-NEGATIVE diff — ratio gate still fires (and the caller's net<0 gate would too)", () => {
    // 2 regressions, 1 improvement: net-negative. The floor only protects
    // net-positive diffs, so the ratio gate still fires.
    const failures = evaluateRegressionThresholds({
      improvements: 1,
      regressionsWasmChange: 2,
      regressedFiles: ["test/a/b/c/d/e.js", "test/f/g/h/i/j.js"],
    });
    expect(failures.some((f) => f.includes("ratio"))).toBe(true);
  });

  it("widens the floor when content-current — 4 regressions / 9 improvements passes (4 < 3+2)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 9,
      regressionsWasmChange: 4,
      regressedFiles: Array.from({ length: 4 }, (_, i) => `test/built-ins/Reg${i}/x/y/t.js`),
      baselineContentCurrent: true,
    });
    expect(failures).toEqual([]);
  });

  it("FAILS even content-current once regressions reach the widened floor — 5 regressions / 9 improvements (5 == 3+2)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 9,
      regressionsWasmChange: 5,
      regressedFiles: Array.from({ length: 5 }, (_, i) => `test/built-ins/Reg${i}/x/y/t.js`),
      baselineContentCurrent: true,
    });
    expect(failures.some((f) => f.includes("ratio"))).toBe(true);
  });

  it("STILL enforces the bucket gate regardless of the floor (a real cluster cannot slip through)", () => {
    // 60 regressions in one bucket is far above the floor, AND the bucket gate
    // fires independently.
    const failures = evaluateRegressionThresholds({
      improvements: 700,
      regressionsWasmChange: 60,
      regressedFiles: Array.from({ length: 60 }, (_, i) => `test/built-ins/Array/prototype/every/case${i}.js`),
      baselineContentCurrent: true,
    });
    expect(failures.some((f) => f.includes("bucket") && f.includes("every") && f.includes("60"))).toBe(true);
  });
});
