import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { loadReactUpstreamSuitePin } from "./setup-react-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("react upstream public-API vectors", () => {
  it("pins the source revision matching the published React version", () => {
    const pin = loadReactUpstreamSuitePin();
    expect(pin.tag).toBe("v19.2.6");
    expect(pin.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");
    expect(pin.testFiles).toEqual([
      "packages/react/src/__tests__/ReactCreateElement-test.js",
      "packages/react/src/__tests__/ReactElementClone-test.js",
    ]);
  });

  const heavy = process.env.DOGFOOD_REACT_UPSTREAM === "1" ? it : it.skip;
  heavy("runs the source-attributed vectors against native and Wasm React", { timeout: 180_000 }, () => {
    const out = execFileSync("npx", ["tsx", join(HERE, "react-upstream-suite.mjs"), "--json"], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const report = JSON.parse(out);
    expect(report.upstreamSuite.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");
    expect(report.results.total).toBe(5);
    expect(report.results.vectors.every((vector: { nativeValue?: number }) => vector.nativeValue === 1)).toBe(true);
    // This is a frontier-reporting harness, not a pass-rate fiction: retain
    // the exact native oracle and every vector even while compiled React
    // currently traps on this public API surface.
    expect(
      report.results.vectors.every((vector: { status: string }) =>
        ["equal", "divergent", "skipped"].includes(vector.status),
      ),
    ).toBe(true);
  });
});
