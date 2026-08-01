import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { loadReactUpstreamSuitePin } from "./setup-react-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Regression floor, not a target. Raise it whenever a compiler fix moves the
// number up; never lower it to make a red run green.
const PASS_FLOOR = 39;
const SCORED_FLOOR = 50;

describe("react upstream suite", () => {
  it("pins the source revision matching the published React version", () => {
    const pin = loadReactUpstreamSuitePin();
    expect(pin.tag).toBe("v19.2.6");
    expect(pin.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");
    // React's entire public `packages/react/src/__tests__` directory — the
    // admitted subset is decided by the extractor at run time and reported by
    // reason, not by hand-picking files here.
    expect(pin.testDirectory).toBe("packages/react/src/__tests__");
    expect(pin.testFiles.length).toBeGreaterThanOrEqual(18);
    for (const file of pin.testFiles) expect(file.startsWith(`${pin.testDirectory}/`)).toBe(true);
  });

  const heavy = process.env.DOGFOOD_REACT_UPSTREAM === "1" ? it : it.skip;
  heavy("runs React's own unit tests against compiled Wasm", { timeout: 600_000 }, () => {
    const out = execFileSync("npx", ["tsx", join(HERE, "react-upstream-suite.mjs"), "--json"], {
      encoding: "utf-8",
      maxBuffer: 128 * 1024 * 1024,
    });
    const report = JSON.parse(out);

    expect(report.upstreamSuite.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");
    expect(report.compile.success).toBe(true);
    expect(report.validation.validates).toBe(true);

    // The admitted slice must stay a real slice of a real suite: every upstream
    // test is either scored or rejected with a recorded reason, never dropped.
    expect(report.extraction.admitted + report.extraction.rejected).toBe(report.extraction.upstreamTestsSeen);
    expect(report.extraction.rejectedTests.every((t: { reason?: string }) => !!t.reason)).toBe(true);

    // A test that cannot even be reproduced natively says nothing about the
    // compiler, so it is excluded from the score — keep that bucket small
    // enough that the scored set stays meaningful.
    expect(report.results.scored).toBeGreaterThanOrEqual(SCORED_FLOOR);
    expect(report.results.passed).toBeGreaterThanOrEqual(PASS_FLOOR);

    // Frontier reporting, not pass-rate fiction: failures stay visible and
    // enumerated rather than being trimmed out of the corpus.
    expect(report.results.passed + report.results.failed).toBe(report.results.scored);
  });
});
